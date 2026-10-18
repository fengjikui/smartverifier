"""EXP-008: legacy/prefix-first × prompt/schema; changing-photo, serial comparison."""
from __future__ import annotations
import argparse
import asyncio
import base64
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'agent-tools/image-focus/src'))
os.environ.update(OMP_NUM_THREADS='2',OPENBLAS_NUM_THREADS='2',VECLIB_MAXIMUM_THREADS='2')
from PIL import Image,ImageEnhance
from smartverifier_focus.lmstudio_transport import LmStudioTransport
from smartverifier_focus.model_trace import TraceWriter
from smartverifier_focus.silkscreen_prompts import BATCH_PROMPT,ordered_messages
spec=importlib.util.spec_from_file_location('board_bench',ROOT/'next/research/whiteboard-batching/benchmark.py')
board=importlib.util.module_from_spec(spec);spec.loader.exec_module(board)
ARMS=[('A','legacy',False),('B','legacy',True),('C','prefix-first',False),('D','prefix-first',True)]


def dump(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');temporary.replace(path)


def prepare(folder):
    if (folder/'manifest.json').exists():raise RuntimeError('拒绝覆盖实验清单')
    folder.mkdir(parents=True,exist_ok=True)
    original=board.prepare(folder/'prepared')
    reference=folder/'reference.png';reference.write_bytes((folder/'prepared/reference.png').read_bytes())
    selected=[next(c for c in original['components'] if c['componentId']==cid) for cid in board.FOUR]
    cases=[];truths=[]
    orders=[[0,1,2,3],[1,3,0,2],[2,0,3,1],[3,2,1,0],[0,2,1,3]]
    for number,brightness in enumerate([1,.96,.91,1.05,.88]):
        components=[]
        for i,c in enumerate(selected):
            cid=f'C{number:02d}{i+1:02d}';filename=folder/f'{cid}.png'
            with Image.open(folder/'prepared'/c['image']['file']) as image:
                changed=ImageEnhance.Brightness(image.convert('RGB')).enhance(brightness)
                changed.save(filename);changed.close()
            component={**c,'componentId':cid,'image':board.info(filename,folder)}
            components.append(component);truths.append(component)
        image=board.compose(folder,components,[components[i]['componentId'] for i in orders[number]],f'photo-{number}.png')
        cases.append({'number':number,'warmup':number==0,'brightness':brightness,'order':orders[number],
                      'componentIds':[c['componentId'] for c in components],'image':image})
    schema_code='import {replyJsonSchema} from '+json.dumps((ROOT/'next/server/vision/reply-json-schema.ts').as_uri())+';let s="";for await(const chunk of process.stdin)s+=chunk;console.log(JSON.stringify(JSON.parse(s).map(replyJsonSchema)));'
    schemas=json.loads(subprocess.check_output(['node','--input-type=module','-e',schema_code],input=json.dumps([c['componentIds'] for c in cases]),text=True,timeout=10))
    for case,schema in zip(cases,schemas):case['schema']=schema
    experiment_id=str(uuid.uuid4())
    manifest={'experiment':'EXP-008','id':experiment_id,'date':'2026-10-18','syntheticOnly':True,'inputBuilderVersion':'split-prefix-v1',
              'reference':board.info(reference,folder),'components':truths,'cases':cases,
              'arms':[{'name':name,'layout':layout,'schema':schema,'fixed':f'实验分组标识，仅用于追溯，不参与检验：{experiment_id}-{name}\n'+BATCH_PROMPT} for name,layout,schema in ARMS],
              'limitations':['仅4块既有生成裁片，多次亮度和排布变换不是独立真实样品','不同条件使用相同PNG及编号，但用独立固定前缀隔离KV缓存；未重置用户缓存','各新图片的首个测试条件轮换，降低图像处理缓存的顺序偏差']}
    dump(folder/'manifest.json',manifest);return manifest


def image_block(folder,asset):
    data=(folder/asset['file']).read_bytes()
    if hashlib.sha256(data).hexdigest()!=asset['sha256']:raise RuntimeError('实际输入哈希改变')
    return {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(data).decode()}}


def prepare_followup(source,folder):
    """保留同一固定前缀，连续测试旧图/全新图/原样重复，排除交错调度的影响。"""
    if folder.exists():raise RuntimeError('补充实验目录必须不存在')
    manifest=json.loads((source/'manifest.json').read_text());folder.mkdir(parents=True)
    assets=[manifest['reference'],*(c['image'] for c in manifest['cases']),*(c['image'] for c in manifest['components'])]
    for asset in assets:
        target=folder/asset['file'];target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/asset['file'],target)
    components=[]
    for i,c in enumerate(manifest['components'][:4]):
        cid=f'C05{i+1:02d}';filename=folder/f'{cid}.png'
        with Image.open(source/c['image']['file']) as image:ImageEnhance.Brightness(image.convert('RGB')).enhance(.935).save(filename)
        components.append({**c,'componentId':cid,'image':board.info(filename,folder)})
    case={**manifest['cases'][0],'number':5,'warmup':False,'brightness':.935,'order':[2,3,0,1],'componentIds':[c['componentId'] for c in components],
          'image':board.compose(folder,components,[components[i]['componentId'] for i in [2,3,0,1]],'photo-5.png')}
    code='import {replyJsonSchema} from '+json.dumps((ROOT/'next/server/vision/reply-json-schema.ts').as_uri())+';console.log(JSON.stringify(replyJsonSchema('+json.dumps(case['componentIds'])+')));'
    case['schema']=json.loads(subprocess.check_output(['node','--input-type=module','-e',code],text=True,timeout=10))
    manifest['components']+=components;manifest['cases'].append(case)
    manifest['probeSchedule']=[[4,'A'],[5,'A'],[5,'A'],[4,'D'],[5,'D'],[5,'D']]
    manifest['phase']='sequential-cache-probe';manifest['limitations'].append('补充连续探针：旧图重复、从未推理的新图、同一新图重复；不与正式4次换图中位数混算')
    dump(folder/'manifest.json',manifest)


def cache_evidence(log,offset,inode):
    if not log.exists() or log.stat().st_ino!=inode or log.stat().st_size<offset:
        return {'status':'unavailable','reason':'日志轮转或不可用'}
    with log.open('rb') as stream:stream.seek(offset);chunk=stream.read()
    lines=[line for line in chunk.decode(errors='replace').splitlines() if 'Prompt cache restore:' in line]
    if len(lines)!=1:return {'status':'ambiguous','reason':'区间内缓存日志不是恰好一条','records':lines}
    match=re.search(r'cached_tokens=(\d+) uncached_tokens=(\d+)',lines[0])
    if not match:return {'status':'unavailable','records':lines}
    cached,uncached=map(int,match.groups())
    return {'status':'observed','cachedTokens':cached,'uncachedTokens':uncached,'expandedInputTokens':cached+uncached,
            'hitFraction':cached/(cached+uncached) if cached+uncached else None,'records':lines}


def validate(response,ids):
    choice=response.get('choices',[{}])[0]
    code='import {parseBatchReply} from '+json.dumps((ROOT/'next/server/vision/local-pipeline.ts').as_uri())+';let s="";for await(const chunk of process.stdin)s+=chunk;const d=JSON.parse(s);parseBatchReply(d.content,d.ids);'
    checked=subprocess.run(['node','--input-type=module','-e',code],input=json.dumps({'content':choice.get('message',{}).get('content',''),'ids':ids}),capture_output=True,text=True,timeout=10)
    return choice.get('finish_reason')=='stop' and checked.returncode==0


async def run(folder,args):
    manifest=json.loads((folder/'manifest.json').read_text())
    if (folder/'run-config.json').exists():raise RuntimeError('拒绝覆盖已有实验；新实验使用新目录')
    for key in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'):os.environ.pop(key,None)
    # 预热四条件；4张变化照片中每个条件恰好先跑一次。
    schedule=[]
    for case in manifest['cases']:
        start=max(0,case['number']-1)
        names=[a['name'] for a in manifest['arms']]
        if case['number']:names=names[start:]+names[:start]
        for name in names:schedule.append((case['number'],name))
    schedule=manifest.get('probeSchedule',schedule)
    dump(folder/'run-config.json',{'model':args.model,'schedule':schedule,'concurrency':1,'maxTokens':1340,'timeoutSeconds':110,'thinking':False,'log':args.log.name})
    (folder/'raw').mkdir(exist_ok=True)
    for sequence,(number,name) in enumerate(schedule):
        case=manifest['cases'][number];arm=next(a for a in manifest['arms'] if a['name']==name)
        before=board.resources()
        status=subprocess.check_output([str(Path.home()/'.lmstudio/bin/lms'),'ps'],text=True,timeout=5)
        row=next((line for line in status.splitlines() if line.split() and line.split()[0]==args.model),'')
        if 'IDLE' not in row:raise RuntimeError('模型不空闲，停止后续实验，不抢占用户推理')
        scope='\n本次必须返回的componentId列表：'+json.dumps(case['componentIds'],ensure_ascii=False)
        messages=ordered_messages(arm['fixed'],scope,image_block(folder,manifest['reference']),image_block(folder,case['image']),arm['layout'])
        trace=TraceWriter(args.trace_dir,{'source':'prefix-experiment','model':args.model,'label':f'EXP-008 {name} · 换图{number}',
             'inputLayout':arm['layout'],'componentIds':case['componentIds']},messages)
        record={'sequence':sequence,'repeat':number,'warmup':case['warmup'],'mode':name,'inputLayout':arm['layout'],'schema':arm['schema'],
                'componentIds':case['componentIds'],'traceId':trace.id,'referenceSha256':manifest['reference']['sha256'],
                'sampleSha256':case['image']['sha256'],'resourcesBefore':before}
        offset=args.log.stat().st_size;inode=args.log.stat().st_ino
        started=time.monotonic();pressure=None;task=None
        try:
            async with LmStudioTransport(args.endpoint,args.model,args.template) as transport:
                if number==0:
                    render_started=time.monotonic()
                    chat=await transport.history(messages)
                    rendered=await transport.model.apply_prompt_template(chat)
                    image_index=rendered.index('<|vision_start|>')
                    ids_index=rendered.index('本次必须返回的componentId列表')
                    fixed_index=rendered.index('实验分组标识')
                    second_image=rendered.index('<|vision_start|>',image_index+1)
                    record['renderedOrder']={'firstImageBeforeIds':image_index<ids_index,'firstImageChar':image_index,'idsChar':ids_index,
                       'fixedRuleChar':fixed_index,'sampleImageChar':second_image,'fixedRulesBeforeReference':fixed_index<image_index,
                       'sha256':hashlib.sha256(rendered.encode()).hexdigest(),'note':'默认模板渲染用于验证块顺序；实际生成仍用已保存的逐请求关闭thinking模板'}
                    record['renderVerificationMs']=round((time.monotonic()-render_started)*1000)
                    if arm['layout']=='prefix-first' and not fixed_index<image_index<second_image<ids_index:
                        raise RuntimeError('实际渲染没有保留固定规则和正品在前的顺序，停止实验')
                call_started=time.monotonic()
                task=asyncio.create_task(transport.complete(messages,None,1340,timeout_seconds=110,on_event=trace.observe,
                                         response_format=case['schema'] if arm['schema'] else None))
                monitors=[]
                while not task.done():
                    done,_=await asyncio.wait({task},timeout=3)
                    if not done:
                        try:monitors.append(await asyncio.to_thread(board.resources))
                        except RuntimeError as exc:
                            pressure=str(exc);task.cancel()
                            try:await task
                            except BaseException:pass
                            raise RuntimeError(pressure)
                record['response']=await task
                record['modelWallMs']=round((time.monotonic()-call_started)*1000)
                record['resourceSamplesDuring']=monitors
            record['callWallMs']=round((time.monotonic()-started)*1000)
            record['cache']=cache_evidence(args.log,offset,inode)
            valid=validate(record['response'],case['componentIds'])
            record['contractValid']=valid;trace.emit('validation',{'valid':valid,'message':'EXP-008完整JSON与编号校验通过。' if valid else 'EXP-008合同未通过，原文保留。'})
        except BaseException as exc:
            if task is not None:
                if not task.done():task.cancel()
                try:await task
                except BaseException:pass
            record['callWallMs']=round((time.monotonic()-started)*1000);record['error']={'type':type(exc).__name__,'message':str(exc)}
            record['cache']=cache_evidence(args.log,offset,inode);trace.emit('error',{'message':str(exc)})
        finally:trace.close()
        try:record['resourcesAfter']=board.resources()
        except RuntimeError as exc:record['resourcesAfter']={'pressure':str(exc)};pressure=str(exc)
        dump(folder/'raw'/f'{sequence:02d}-{name}-{number}.json',record)
        stats=record.get('response',{}).get('lmstudio',{}).get('stats',{})
        print(json.dumps({'sequence':sequence,'arm':name,'case':number,'warmup':case['warmup'],'ms':record['callWallMs'],
            'ttft':stats.get('timeToFirstTokenSec'),'tokens':stats.get('predictedTokensCount'),'cache':record.get('cache'),
            'contractValid':record.get('contractValid'),'renderedOrder':record.get('renderedOrder'),'error':record.get('error')},ensure_ascii=False),flush=True)
        if record.get('error') or pressure:raise RuntimeError('停止后续本机负载，已保存本次原文及错误')
        await asyncio.sleep(1.5)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','prepare-probe','run']);parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--source',type=Path)
    parser.add_argument('--trace-dir',type=Path,default=ROOT/'outputs/next-state/vision-traces')
    parser.add_argument('--model',default='hr-qwen');parser.add_argument('--endpoint',default='http://127.0.0.1:1234/v1')
    parser.add_argument('--template',default=str(Path.home()/'.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-4bit/chat_template.jinja'))
    parser.add_argument('--log',type=Path,default=Path.home()/'.lmstudio/server-logs'/datetime.now().strftime('%Y-%m/%Y-%m-%d.1.log'))
    args=parser.parse_args();folder=args.out.resolve()
    if args.action=='prepare':
        result=prepare(folder);print(json.dumps({'cases':len(result['cases']),'arms':len(result['arms']),'directory':str(folder)},ensure_ascii=False))
    elif args.action=='prepare-probe':
        if not args.source:parser.error('prepare-probe需要--source指向已完成的正式实验')
        prepare_followup(args.source.resolve(),folder)
    else:asyncio.run(run(folder,args))

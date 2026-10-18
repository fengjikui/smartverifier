"""EXP-007：同一组自动裁片，逐件与4/6件原像素白板的串行受控比较。"""
from __future__ import annotations
import argparse
import asyncio
import base64
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
from statistics import median
import subprocess
import sys
import time

os.environ['OMP_NUM_THREADS']='2'
os.environ['OPENBLAS_NUM_THREADS']='2'
os.environ['VECLIB_MAXIMUM_THREADS']='2'
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'agent-tools/image-focus/src'))
from PIL import Image,ImageDraw,ImageFont
from smartverifier_focus.lmstudio_transport import LmStudioTransport
spec=importlib.util.spec_from_file_location('vision_worker',ROOT/'next/server/vision/local_worker.py')
vision=importlib.util.module_from_spec(spec);spec.loader.exec_module(vision)

FOUR=['C02','C03','C04','C06']
PROMPT_VERSION='silkscreen-controlled-layout-v1'
from smartverifier_focus.silkscreen_prompts import BATCH_PROMPT as PROMPT


def dump(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    temporary.replace(path)


def info(path,folder):
    with Image.open(path) as image:width,height=image.size
    return {'file':str(path.relative_to(folder)),'width':width,'height':height,
            'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def compose(folder,components,ids,filename):
    selected=[next(c for c in components if c['componentId']==cid) for cid in ids]
    gap,label=16,48
    cellw=max(c['image']['width'] for c in selected)
    cellh=max(c['image']['height'] for c in selected)+label
    options=[]
    for cols in range(1,len(selected)+1):
        rows=(len(selected)+cols-1)//cols
        w=cols*cellw+(cols+1)*gap;h=rows*cellh+(rows+1)*gap
        options.append((abs(math.log(w/h)),w*h,cols,w,h))
    _,_,cols,w,h=min(options)
    board=Image.new('RGB',(w,h),'white');draw=ImageDraw.Draw(board);font=ImageFont.load_default(size=32)
    placements=[]
    for i,c in enumerate(selected):
        with Image.open(folder/c['image']['file']) as source:image=source.convert('RGB')
        x=gap+i%cols*(cellw+gap);y=gap+i//cols*(cellh+gap)+label
        board.paste(image,(x,y));draw.text((x,y-label+7),c['componentId'],font=font,fill=(40,40,40))
        assert board.crop((x,y,x+image.width,y+image.height)).tobytes()==image.tobytes()
        placements.append({'componentId':c['componentId'],'x':x,'y':y,'width':image.width,'height':image.height})
        image.close()
    file=folder/filename;board.save(file);board.close()
    return {**info(file,folder),'scale':1,'placements':placements,'composePolicy':'原始裁片像素逐像素保留；标签位于白底，不覆盖元件'}


def prepare(folder):
    folder.mkdir(parents=True,exist_ok=True);(folder/'files').mkdir(exist_ok=True)
    manifest_source=ROOT/'fixtures/inspection/green-mat-v1/manifest.json'
    truth=json.loads(manifest_source.read_text())['expected'];components=[];sources=[]
    for name in ['single','pair','dim-three']:
        vision.check_resources()
        source=ROOT/f'fixtures/inspection/green-mat-v1/{name}.png'
        prepared=vision.separate({'source':str(source),'folder':str(folder/'files'),'label':name})
        if prepared['coverage']!='complete' or len(prepared['components'])!=len(truth[name]):
            raise RuntimeError('本次分离数量未通过人工清单核对，不能开始布局实验')
        sources.append({'file':str(source.relative_to(ROOT)),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'elapsedMs':prepared['elapsedMs'],'count':len(prepared['components'])})
        for i,c in enumerate(prepared['components']):
            if c['quality']['state']!='usable':raise RuntimeError('存在需重拍裁片，停止比较')
            cid='C'+str(len(components)+1).zfill(2)
            crop=folder/'files'/c['modelView']['assetId']
            components.append({'componentId':cid,'source':name,'sourceIndex':i,'image':info(crop,folder),
                               'expectedLines':truth[name][i],'expectedVerdict':'FAIL' if truth[name][i][0]=='SV385' else 'PASS',
                               'referenceDependent':name=='single','geometry':{'quadPx':c['quadPx'],'rotation':c['rotationClockwiseDegrees']}})
    reference=ROOT/'fixtures/inspection/green-mat-v1/reference-crop.png'
    ref=folder/'reference.png';ref.write_bytes(reference.read_bytes())
    result={'experiment':'EXP-007','date':'2026-10-18','syntheticOnly':True,'datasetManifestSha256':hashlib.sha256(manifest_source.read_bytes()).hexdigest(),
            'sources':sources,'reference':info(ref,folder),'components':components,
            'groups':{'four':FOUR,'six':[c['componentId'] for c in components]},
            'sheets':{'four':compose(folder,components,FOUR,'sheet-4.png'),'six':compose(folder,components,[c['componentId'] for c in components],'sheet-6.png')}}
    dump(folder/'manifest.json',result);return result


def resources():
    import psutil
    before=vision.check_resources();cpu=psutil.cpu_percent(interval=.2)
    if cpu>90:raise RuntimeError('RESOURCE_PRESSURE: CPU总利用率超过90%，暂停实验')
    return {**before,'cpuPercent':cpu,'load':os.getloadavg()}


def image_block(folder,asset,metrics):
    data=(folder/asset['file']).read_bytes()
    if hashlib.sha256(data).hexdigest()!=asset['sha256']:raise RuntimeError('模型输入哈希改变，停止实验')
    metrics.append({'inputIndex':len(metrics),'sha256':asset['sha256'],'sentWidth':asset['width'],'sentHeight':asset['height'],
                    'encodedBytes':len(data),'effectiveWidth':None,'effectiveHeight':None})
    return {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(data).decode()}}


async def run(folder,args,permutation=False):
    config_file=folder/('permutation-config.json' if permutation else 'run-config.json')
    if config_file.exists():raise RuntimeError('已有实验配置，禁止覆盖；请创建新的输出目录')
    manifest=json.loads((folder/'manifest.json').read_text());components=manifest['components'];allids=manifest['groups']['six']
    for key in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'):os.environ.pop(key,None)
    if permutation:
        # 只换排布，不换图片或标签，兼测串号，并避免把立即重复输入的缓存收益当新照片性能。
        manifest['permutedSheets']={'four':compose(folder,components,list(reversed(FOUR)),'sheet-4-permuted.png'),
                                    'six':compose(folder,components,list(reversed(allids)),'sheet-6-permuted.png')}
        dump(folder/'manifest.json',manifest)
        schedule=[(3,'permuted4',FOUR),(3,'permuted6',allids)]
        offset=len(list((folder/'raw').glob('*.json')))
    else:
        schedule=[(0,'warmup',[allids[0]])];offset=0
        for repeat in range(1,args.repeats+1):
            singles=[(repeat,'single',[cid]) for cid in (allids if repeat%2 else list(reversed(allids)))]
            boards=[(repeat,'board4',FOUR),(repeat,'board6',allids)]
            schedule.extend(singles+boards if repeat%2 else list(reversed(boards))+singles)
    runinfo={'model':args.model,'templateFile':Path(args.template).name,'sdk':'1.5.0','temperature':0,'thinking':False,'promptVersion':PROMPT_VERSION,
        'promptBase':PROMPT,'maxTokensRule':'220 + 280 * componentCount','requestTimeoutSeconds':110,'repeats':args.repeats,'concurrency':1,
        'timingScope':'模型耗时含SDK图片准备上传、预填充和生成；另记校验资源/子进程/保存以外的调用墙钟；不含共用分离步骤及轮间休息',
        'schedule':[{'repeat':r,'mode':m,'ids':ids} for r,m,ids in schedule]}
    dump(config_file,runinfo)
    for number,(repeat,mode,ids) in enumerate(schedule,offset):
        recordfile=folder/'raw'/f'{number:02d}-{mode}-r{repeat}.json'
        if recordfile.exists():raise RuntimeError('已有调用记录，禁止覆盖；请创建新的输出目录')
        before=resources()
        # 确保没有抢占用户主动发起的推理，不改变共享模型加载状态。
        status=subprocess.check_output([str(Path.home()/'.lmstudio/bin/lms'),'ps'],text=True,timeout=5)
        modelrow=next((line for line in status.splitlines() if line.split() and line.split()[0]==args.model),'')
        if 'IDLE' not in modelrow:raise RuntimeError('目标模型未处于空闲加载状态，停止实验，请稍后重跑')
        sample=next(c['image'] for c in components if c['componentId']==ids[0]) if mode in ('single','warmup') else manifest['permutedSheets' if permutation else 'sheets']['four' if mode in ('board4','permuted4') else 'six']
        text=PROMPT+'\n本次必须返回的componentId列表：'+json.dumps(ids,ensure_ascii=False)
        metrics=[];content=[{'type':'text','text':text},image_block(folder,manifest['reference'],metrics),image_block(folder,sample,metrics)]
        record={'sequence':number,'repeat':repeat,'mode':mode,'componentIds':ids,'inputMetrics':metrics,'promptSha256':hashlib.sha256(text.encode()).hexdigest(),'resourcesBefore':before}
        trace=None
        if args.trace_dir:
            from smartverifier_focus.model_trace import TraceWriter
            trace=TraceWriter(args.trace_dir,{'source':'benchmark','model':args.model,'componentIds':ids,'label':f'白板实验 R{repeat} · {mode}'},[{'role':'user','content':content}])
            record['traceId']=trace.id
        started=time.monotonic()
        try:
            async with LmStudioTransport(args.endpoint,args.model,args.template) as transport:
                call_started=time.monotonic()
                record['response']=await transport.complete([{'role':'user','content':content}],None,220+280*len(ids),timeout_seconds=110,on_event=trace.observe if trace else None)
                record['modelWallMs']=round((time.monotonic()-call_started)*1000)
        except Exception as exc:
            record['error']={'type':type(exc).__name__,'message':str(exc)}
            if trace:trace.emit('error',{'message':str(exc)})
        finally:
            record['callWallMs']=round((time.monotonic()-started)*1000)
            if trace:
                try:
                    choice=record.get('response',{}).get('choices',[{}])[0]
                    if not record.get('error'):
                        code='import {parseBatchReply} from '+json.dumps((ROOT/'next/server/vision/local-pipeline.ts').as_uri())+'; let input=""; for await(const chunk of process.stdin)input+=chunk; const data=JSON.parse(input); parseBatchReply(data.content,data.ids);'
                        checked=subprocess.run(['node','--input-type=module','-e',code],input=json.dumps({'content':choice.get('message',{}).get('content',''),'ids':ids}),text=True,capture_output=True,timeout=10)
                        valid=choice.get('finish_reason')=='stop' and checked.returncode==0
                        trace.emit('validation',{'valid':valid,'message':'完整JSON与编号校验通过。' if valid else '生成未结束或合同校验失败，原文已保留。'})
                except Exception as exc:
                    trace.emit('validation',{'valid':False,'message':'调试校验器未完成：'+str(exc)})
                finally:trace.close()
        try:record['resourcesAfter']=resources()
        except RuntimeError as exc:record['resourcesAfter']={'pressure':str(exc)}
        dump(recordfile,record)
        choice=record.get('response',{}).get('choices',[{}])[0]
        print(json.dumps({'number':number,'repeat':repeat,'mode':mode,'count':len(ids),'modelWallMs':record.get('modelWallMs'),'callWallMs':record['callWallMs'],'finish':choice.get('finish_reason'),'error':record.get('error'),'responsePreview':choice.get('message',{}).get('content','')[:140]},ensure_ascii=False),flush=True)
        if record['resourcesAfter'].get('pressure'):raise RuntimeError(record['resourcesAfter']['pressure'])
        if record.get('error'):raise RuntimeError('本次调用失败，保留原文并停止后续负载')
        await asyncio.sleep(1.5)


def time_composition(folder):
    result_file=folder/'composition-timings.json'
    if result_file.exists():raise RuntimeError('已有合成计时，禁止覆盖；请在新的实验目录测量')
    manifest=json.loads((folder/'manifest.json').read_text())
    result={'resources':resources(),'rows':[]}
    for group,ids in manifest['groups'].items():
        durations=[]
        for repeat in range(3):
            resources()
            started=time.monotonic()
            board=compose(folder,manifest['components'],ids,f'compose-probe-{group}-{repeat}.png')
            durations.append(round((time.monotonic()-started)*1000,2))
            if board['sha256']!=manifest['sheets'][group]['sha256']:
                raise RuntimeError('重新合成与模型输入PNG哈希不一致，停止计时')
        result['rows'].append({'group':group,'elapsedMs':durations,'medianMs':median(durations),'pixelAndPngHashMatchesInferenceInput':True})
    result['resourcesAfter']=resources()
    dump(result_file,result)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','run','permute','time-compose']);parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--model',default='hr-qwen');parser.add_argument('--endpoint',default='http://127.0.0.1:1234/v1');parser.add_argument('--template',default=str(Path.home()/'.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-4bit/chat_template.jinja'))
    parser.add_argument('--trace-dir',type=Path,help='可选：将新调用的实际输入、流片段与逐件时序写入调试记录目录')
    parser.add_argument('--repeats',type=int,default=2);args=parser.parse_args()
    if not 1<=args.repeats<=3:parser.error('首轮实验重复次数限定1到3，控制本机负载')
    folder=args.out.resolve()
    if args.action=='prepare':
        if (folder/'manifest.json').exists():parser.error('目录已有清单，不覆盖旧实验')
        result=prepare(folder);print(json.dumps({'out':str(folder),'sheets':result['sheets']},ensure_ascii=False))
    elif args.action=='time-compose':print(json.dumps(time_composition(folder),ensure_ascii=False))
    else:asyncio.run(run(folder,args,permutation=args.action=='permute'))

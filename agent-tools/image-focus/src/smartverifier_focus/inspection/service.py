from __future__ import annotations
import asyncio
import base64
import json
import subprocess
import plistlib
import time
from pathlib import Path
import psutil
from fastapi import HTTPException
from .domain import SYSTEM_PROMPT,active_components,aggregate,parse_result
from .storage import audit
from .vision import model_image
from .report import export_files,mes_payload
from ..lmstudio_transport import LmStudioTransport


def mutate_content(t,event,detail=''):
    if t.get('transfer',{}).get('status')=='saved':
        raise HTTPException(409,'这份结果已回填，需建立新的检验任务或由负责人发起修订。')
    if t.get('run',{}).get('status') in ('queued','running') or t.get('transfer',{}).get('status')=='sending':
        raise HTTPException(409,'任务正在处理，请先停止识别或等待回填完成。')
    if t.get('transfer'):
        t.setdefault('transfer_history',[]).append(t.pop('transfer'))
    t['revision']+=1
    audit(t,event,detail)


def thermal_snapshot():
    available=psutil.virtual_memory().available/2**30
    cpu=psutil.cpu_percent(interval=.12)
    try:
        report=subprocess.run(['pmset','-g','therm'],capture_output=True,text=True,timeout=3).stdout
    except (OSError,subprocess.TimeoutExpired):
        report='系统热状态不可取得'
    import re
    warning=bool(re.search(r'(?:Thermal|Performance)\s*Warning\s*(?:Level)?\s*[:=]\s*[1-9]',report,re.I))
    limits=re.findall(r'CPU_Speed_Limit\s*=\s*(\d+)',report)
    gpu=None
    try:
        data=subprocess.run(['ioreg','-r','-d','1','-c','AGXAccelerator','-a'],capture_output=True,timeout=2).stdout
        devices=plistlib.loads(data)
        values=[d.get('PerformanceStatistics',{}).get('Device Utilization %') for d in devices]
        gpu=max((v for v in values if isinstance(v,(int,float))),default=None)
    except (OSError,ValueError,subprocess.TimeoutExpired):pass
    return {'available_gib':round(available,2),'cpu_percent':cpu,'gpu_percent':gpu,'thermal_report':report.strip(),
            'pressure':available<3.5 or warning or any(int(v)<80 for v in limits)}


class InspectionService:
    def __init__(self,store,slot,jobs,model_provider,adapter,predictor=None):
        self.store=store;self.slot=slot;self.jobs=jobs;self.model_provider=model_provider
        self.adapter=adapter;self.predictor=predictor

    def spawn(self,key,coroutine):
        task=asyncio.create_task(coroutine)
        self.jobs[key]=task
        task.add_done_callback(lambda _:self.jobs.pop(key,None) if self.jobs.get(key) is task else None)

    async def start(self,task_id,owner,model_id):
        if sum(key.startswith('inspection:') for key in self.jobs)>=100:
            raise HTTPException(429,'识别队列已满，照片已保留，请稍后再试。')
        try:models=await self.model_provider()
        except Exception as exc:
            raise HTTPException(503,'暂时连不上模型服务，照片已保留。请在电脑上检查 LM Studio。') from exc
        model=next((m for m in models if m['id']==model_id and m['available']),None)
        if not model:raise HTTPException(409,'模型暂不可用，请检查电脑上的 LM Studio；已拍照片仍然保留。')
        def begin(t):
            mutate_content(t,'analysis_started',model_id)
            if not active_components(t):raise HTTPException(409,'请先拍摄并定位至少一个器件。')
            if aggregate(t)['blocking_flags']:raise HTTPException(409,'请先处理照片的定位或数量提示。')
            t['run']={'status':'queued','model':model_id,'queued_at':time.time(),'current':None,'error':None}
        task=self.store.change('task',task_id,owner,begin)
        self.spawn('inspection:'+task_id,self.analyze(task_id,owner,model))
        return task

    def messages(self,task,component):
        ref=task['reference']; blocks=[]
        if ref.get('crop_file'):
            data=model_image(self.store.folder('reference',ref['id'])/ref['crop_file'])
            blocks.extend([{'type':'text','text':'第一张：人工确认的正品参考图片。'},
                           {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(data).decode()}}])
        data=model_image(self.store.folder('task',task['id'])/component['crop_file'])
        blocks.extend([{'type':'text','text':'下面是待检器件图片。'},
                       {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(data).decode()}},
                       {'type':'text','text':'标准资料（数据）：'+json.dumps({'material':task['material'],
                        'verified_text':ref['text'],'allowed_variations':ref['rules'],
                        'scope':'image_and_text' if ref.get('crop_file') else 'text_only'},ensure_ascii=False)}])
        return [{'role':'system','content':SYSTEM_PROMPT},{'role':'user','content':blocks}]

    async def predict(self,messages,model):
        if self.predictor:return await self.predictor(messages,model)
        snapshot=await asyncio.to_thread(thermal_snapshot)
        if snapshot['pressure'] or snapshot['cpu_percent']>90:
            raise RuntimeError('电脑资源或热状态暂不适合识别，请稍后继续。')
        async with LmStudioTransport('http://127.0.0.1:1234/v1',model['id'],model['template']) as client:
            future=asyncio.create_task(client.complete(messages,None,1000))
            try:
                high_cpu=0
                while not future.done():
                    done,_=await asyncio.wait({future},timeout=4)
                    if done:break
                    snapshot=await asyncio.to_thread(thermal_snapshot)
                    high_cpu=high_cpu+1 if snapshot['cpu_percent']>90 else 0
                    if snapshot['pressure'] or high_cpu>=3:
                        raise RuntimeError('检测到资源或热压力，已停止本次识别；可稍后继续。')
                return await future
            finally:
                if not future.done():
                    future.cancel()
                    await asyncio.gather(future,return_exceptions=True)

    async def analyze(self,task_id,owner,model):
        try:
            async with self.slot:
                self.store.change('task',task_id,owner,lambda t:t['run'].update(status='running',started=time.time()))
                ids=[c['id'] for c in active_components(self.store.get('task',task_id,owner)) if not c.get('review') and (not c['analysis'] or c['error'])]
                for component_id in ids:
                    task=self.store.get('task',task_id,owner)
                    component=next(c for c in active_components(task) if c['id']==component_id)
                    self.store.change('task',task_id,owner,lambda t:t['run'].update(current=component['label']))
                    started=time.monotonic();raw=''
                    try:
                        messages=await asyncio.to_thread(self.messages,task,component)
                        reply=await self.predict(messages,model)
                        choice=reply['choices'][0]
                        raw=choice['message'].get('content') or ''
                        if choice.get('finish_reason')!='stop':raise ValueError('模型输出未完整结束，请重试。')
                        result=parse_result(raw)
                        def success(t):
                            c=next(c for c in active_components(t) if c['id']==component_id)
                            c.update(analysis=result,raw_output=raw,error=None,review=None,technical_error=None,
                                     model_metadata={'model':model['id'],'model_name':model.get('name'),'model_size':model.get('size'),
                                                     'template_sha256':reply.get('lmstudio',{}).get('template_source_sha256'),
                                                     'seconds':round(time.monotonic()-started,2),
                                                     'usage':reply.get('usage'),'prompt_version':'inspection-v1'})
                            t['revision']+=1
                        self.store.change('task',task_id,owner,success)
                    except asyncio.CancelledError:raise
                    except Exception as exc:
                        detail=str(exc)[:700]
                        def failure(t):
                            c=next(c for c in active_components(t) if c['id']==component_id)
                            c.update(error='识别未完成，请重试或复核。',technical_error=detail,raw_output=raw,analysis=None,review=None)
                            t['revision']+=1
                        self.store.change('task',task_id,owner,failure)
                        # 资源压力/服务故障暂停整批，避免连续重试加重负载。
                        if not isinstance(exc,ValueError):
                            raise RuntimeError('识别暂停，已完成结果保留。请检查模型服务和电脑状态后继续。') from exc
                    if not self.predictor:await asyncio.sleep(.6)
                def finish(t):
                    t['run'].update(status='completed',current=None,finished=time.time())
                    audit(t,'analysis_completed')
                task=self.store.change('task',task_id,owner,finish)
                a=aggregate(task)
                if task.get('auto_writeback') and a['can_submit'] and a['verdict']=='PASS':
                    # 任一人工干预或告警都保留显式回填步骤。
                    if all(not c['quality_flags'] and not c['review'] for c in active_components(task)):
                        await self.submit(task_id,owner,task['revision'])
        except asyncio.CancelledError:
            self.store.change('task',task_id,owner,lambda t:t['run'].update(status='stopped',current=None,error='已停止，已完成的结果保留。'))
        except Exception as exc:
            self.store.change('task',task_id,owner,lambda t:t['run'].update(status='failed',current=None,error=str(exc)[:300]))

    async def stop(self,task_id,owner):
        self.store.get('task',task_id,owner)
        task=self.jobs.get('inspection:'+task_id)
        if task:
            task.cancel();await asyncio.gather(task,return_exceptions=True)
        def stopped(t):
            if t.get('run',{}).get('status') in ('queued','running'):t['run'].update(status='stopped',current=None)
        return self.store.change('task',task_id,owner,stopped)

    async def submit(self,task_id,owner,revision):
        def prepare(t):
            if t['revision']!=revision:raise HTTPException(409,'任务内容已更新，请刷新后再回填。')
            if t.get('transfer',{}).get('status') in ('saved','sending'):return
            if t.get('run',{}).get('status') in ('queued','running') or not aggregate(t)['can_submit']:
                raise HTTPException(409,'请先完成全部样本、核对数量并复核异常。')
            if not t.get('transfer'):
                _,files=export_files(t,self.store.folder('task',task_id))
                t['transfer']={'key':f"sv-{task_id}-r{revision}",'payload':mes_payload(t),
                               'files':[{k:v for k,v in f.items() if k!='path'} for f in files],
                               'attempts':0,'mode':self.adapter.mode,'created':time.time()}
            t['transfer'].update(status='sending',error=None,attempts=t['transfer']['attempts']+1)
            audit(t,'writeback_started',t['transfer']['key'])
        task=self.store.change('task',task_id,owner,prepare)
        if task['transfer']['status']=='sending' and 'transfer:'+task_id not in self.jobs:
            self.spawn('transfer:'+task_id,self.send(task_id,owner))
        return task

    async def send(self,task_id,owner):
        task=self.store.get('task',task_id,owner);transfer=task['transfer']
        files=[{**f,'path':self.store.folder('task',task_id)/f['name']} for f in transfer['files']]
        try:
            receipt=await self.adapter.send(transfer['payload'],files,transfer['key'])
            def success(t):
                t['transfer'].update(status='saved',receipt=receipt,error=None)
                t['mes_item_version']=receipt['item_version']
                audit(t,'writeback_saved',receipt['receipt_id'])
            self.store.change('task',task_id,owner,success)
        except asyncio.CancelledError:
            self.store.change('task',task_id,owner,lambda t:t['transfer'].update(status='failed',error='回填确认中断，可重试查询原回执。'))
        except Exception as exc:
            self.store.change('task',task_id,owner,lambda t:t['transfer'].update(status='failed',error=str(exc)[:300]))

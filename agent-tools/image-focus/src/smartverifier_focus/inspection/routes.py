"""平板任务接口。与旧版图片聊天共用配对会话及单路推理资源。"""
from __future__ import annotations
import asyncio
import hashlib
import time
import zipfile
from pathlib import Path
from typing import Literal
from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import Field
from PIL import Image
from .domain import StrictModel, active_components, aggregate, final_verdict
from .storage import InspectionStore, ident, audit
from .vision import MAX_BYTES, process_photo
from .service import InspectionService, mutate_content, thermal_snapshot
from .mes import adapter_from_env
from .report import export_files


class Profile(StrictModel):
    employee_id: str=Field(min_length=1,max_length=60)
    name: str=Field(min_length=1,max_length=60)


class TaskInput(StrictModel):
    number: str=Field(min_length=1,max_length=100,pattern=r'^[^/\\?#]+$')
    material: str=Field(min_length=1,max_length=150)
    expected_count: int=Field(ge=1,le=100)
    reference_id: str
    capture_mode: Literal['single','multi']='single'
    item_id: str=Field(default='silkscreen',min_length=1,max_length=60,pattern=r'^[A-Za-z0-9_-]+$')
    mes_item_version: str=Field(default='0',max_length=100,pattern=r'^[A-Za-z0-9._:-]+$')
    auto_writeback: bool=False


class AnalyzeInput(StrictModel):
    model_id: str=Field(min_length=1,max_length=150)


class RevisionInput(StrictModel):
    revision: int=Field(ge=1)


class ReviewInput(StrictModel):
    verdict: Literal['PASS','FAIL']
    reason: str=Field(min_length=5,max_length=500)


async def read_upload(file):
    data=bytearray()
    while chunk:=await file.read(1024*1024):
        data.extend(chunk)
        if len(data)>MAX_BYTES:raise HTTPException(413,'照片超过 64 MB，请调整相机分辨率。')
    return bytes(data)


def install(app,root,slot,image_slot,jobs,model_provider,*,predictor=None,adapter=None):
    store=InspectionStore(root/'inspection')
    model_lock=asyncio.Lock()
    model_cache={'until':0,'items':[]}
    async def cached_models():
        # 多台平板同时刷新时，只向 LM Studio 查询一次；推理 transport 仍会核实模型已加载。
        async with model_lock:
            if time.monotonic()<model_cache['until']:return model_cache['items']
            try:model_cache['items']=await model_provider()
            except Exception:
                model_cache.update(until=time.monotonic()+3,items=[])
                raise
            model_cache['until']=time.monotonic()+3
            return model_cache['items']
    service=InspectionService(store,slot,jobs,cached_models,adapter or adapter_from_env(store.root),predictor)
    app.state.inspection=service
    prefix='/api/inspection'
    upload_slots=asyncio.Semaphore(4)

    def profile(owner):
        values=store.list('profile',owner)
        return values[0] if values else None

    def file_url(kind,key,name):
        return f'{prefix}/files/{kind}/{key}/{name}'

    def reference_view(ref):
        return {**{k:v for k,v in ref.items() if k!='owner'},
                'image_url':file_url('reference',ref['id'],ref['crop_file']) if ref.get('crop_file') else None}

    def task_view(task,compact=False):
        result={k:v for k,v in task.items() if k not in ('owner','audit','transfer_history')}
        result['summary']=aggregate(task)
        if task.get('run',{}).get('status')=='queued':
            queue=[key.removeprefix('inspection:') for key,job in jobs.items() if key.startswith('inspection:') and not job.done()]
            ahead=queue.index(task['id']) if task['id'] in queue else 0
            result['run']={**task['run'],'ahead':ahead}
        if compact:
            return {k:result.get(k) for k in ('id','number','material','expected_count','updated','summary','run','transfer','synthetic_test')}
        result['reference']=reference_view(task['reference'])
        result['photos']=[]
        for p in task['photos']:
            if p['deleted']:continue
            photo={k:v for k,v in p.items() if k not in ('components','request_id','normalized_file')}
            photo['preview_url']=file_url('task',task['id'],p['preview_file'])
            photo['original_url']=file_url('task',task['id'],p['original_file'])
            photo['annotation_url']=file_url('task',task['id'],p['annotation_file'])
            photo['components']=[{**{k:v for k,v in c.items() if k not in ('raw_output','technical_error')},
                 'image_url':file_url('task',task['id'],c['crop_file']),'final_verdict':final_verdict(c)} for c in p['components']]
            result['photos'].append(photo)
        if result.get('transfer'):
            result['transfer']={k:v for k,v in result['transfer'].items() if k not in ('payload','files')}
        return result

    async def model_options():
        try:
            models=await cached_models()
            return [{k:v for k,v in m.items() if k!='template'} for m in models]
        except Exception:return []

    @app.get(prefix+'/bootstrap')
    async def bootstrap(request:Request):
        owner=request.state.owner
        return {'profile':profile(owner),'references':[reference_view(r) for r in store.list('reference',owner)],
                'tasks':[task_view(t,True) for t in store.list('task',owner)],'models':await model_options(),
                'mes_mode':service.adapter.mode,'identity_mode':'local_trial'}

    @app.put(prefix+'/profile')
    async def set_profile(data:Profile,request:Request):
        value={**data.model_dump(),'identity_source':'local_trial'}
        old=profile(request.state.owner)
        return (store.change('profile',old['id'],request.state.owner,lambda p:p.update(value)) if old
                else store.create('profile',request.state.owner,value))

    async def add_reference(owner,name,text,rules,approved,data=None,synthetic=False):
        person=profile(owner)
        if not person:raise HTTPException(409,'请先填写试用检验员。')
        if not approved:raise HTTPException(400,'标准需要人工核对后才能使用。')
        if not name.strip() or not (text.strip() or data):raise HTTPException(400,'请填写标准名称，并提供图片或核对过的文字。')
        key=ident();folder=store.folder('reference',key)
        ref={'id':key,'name':name.strip()[:120],'text':text.strip()[:4000],'rules':rules.strip()[:2000],
             'version':1,'approved_by':{k:person[k] for k in ('employee_id','name','identity_source')},
             'approved_at':time.time(),'crop_file':None,'synthetic_test':synthetic}
        if data:
            async with image_slot:
                try:photo=await asyncio.to_thread(process_photo,data,folder,ident(),'REF','single',resource_check=None if predictor else thermal_snapshot)
                except (ValueError,OSError) as exc:raise HTTPException(400,str(exc)) from exc
            if photo['flags'] or len(photo['components'])!=1:
                raise HTTPException(400,'参考照片未能定位到单个完整器件，请用纯色背景重新拍摄。也可先使用经核对的文字标准。')
            ref.update(crop_file=photo['components'][0]['crop_file'],photo=photo,
                       quality_flags=photo['components'][0]['quality_flags'])
            if ref['quality_flags']:raise HTTPException(400,'标准照片质量不足：'+'；'.join(ref['quality_flags']))
        return store.create('reference',owner,ref)

    @app.post(prefix+'/references')
    async def reference(request:Request,name:str=Form(...,max_length=120),text:str=Form('',max_length=4000),
                        rules:str=Form('',max_length=2000),approved:bool=Form(False),file:UploadFile|None=File(None)):
        return reference_view(await add_reference(request.state.owner,name,text,rules,approved,await read_upload(file) if file else None))

    def add_task(owner,data,synthetic=False):
        person=profile(owner)
        if not person:raise HTTPException(409,'请先填写试用检验员。')
        ref=store.get('reference',data.reference_id,owner)
        if any(t['number']==data.number and t['item_id']==data.item_id for t in store.list('task',owner)):
            raise HTTPException(409,'这个单号的丝印任务已存在，请回到列表继续原任务。')
        value={**data.model_dump(),'reference':ref,'photos':[],'photo_counter':0,'revision':1,
               'created':time.time(),'run':{'status':'idle'},'inspector':{k:person[k] for k in ('employee_id','name','identity_source')},
               'synthetic_test':synthetic or ref.get('synthetic_test',False),'audit':[]}
        audit(value,'task_created',data.number)
        return store.create('task',owner,value)

    @app.post(prefix+'/tasks')
    async def new_task(data:TaskInput,request:Request):
        return task_view(add_task(request.state.owner,data))

    @app.get(prefix+'/tasks/{task_id}')
    async def task(task_id:str,request:Request):
        return task_view(store.get('task',task_id,request.state.owner))

    async def add_photo(task_id,owner,data,request_id,replace_id=''):
        if len(request_id)>100:raise HTTPException(400,'上传请求标识过长。')
        # 串行定位与事务提交，避免多个上传取得同一照片编号。
        async with image_slot:
            current=store.get('task',task_id,owner)
            digest=hashlib.sha256(data).hexdigest()
            for p in current['photos']:
                if p.get('request_id')==request_id:
                    if p['sha256']!=digest:raise HTTPException(409,'同一上传请求的图片发生变化。')
                    return current
                if not p['deleted'] and p['sha256']==digest:raise HTTPException(409,f"这张照片已经保存为 {p['label']}，不会重复计数。")
            if sum(not p['deleted'] for p in current['photos'])>=100 and not replace_id:
                raise HTTPException(400,'单个任务最多保存 100 张有效照片。')
            mutate_content(current,'photo_preflight')
            label=f"P{current['photo_counter']+1:03d}"
            try:p=await asyncio.to_thread(process_photo,data,store.folder('task',task_id),ident(),label,current['capture_mode'],resource_check=None if predictor else thermal_snapshot)
            except (ValueError,OSError) as exc:raise HTTPException(400,'照片处理失败：'+str(exc)[:200]) from exc
            p['request_id']=request_id
            def apply(t):
                mutate_content(t,'photo_added',label)
                if replace_id:
                    old=next((p for p in t['photos'] if p['id']==replace_id and not p['deleted']),None)
                    if not old:raise HTTPException(409,'被替换的照片已发生变化。')
                    old['deleted']=True;audit(t,'photo_replaced',old['label']+' → '+label)
                t['photo_counter']+=1;t['photos'].append(p)
            return store.change('task',task_id,owner,apply)

    @app.post(prefix+'/tasks/{task_id}/photos')
    async def upload_photo(task_id:str,request:Request,file:UploadFile=File(...),request_id:str=Form(...),replace_id:str=Form('')):
        store.get('task',task_id,request.state.owner)
        if upload_slots.locked():raise HTTPException(429,'电脑正在保存其他照片，请稍后重试。')
        async with upload_slots:
            return task_view(await add_photo(task_id,request.state.owner,await read_upload(file),request_id,replace_id))

    @app.post(prefix+'/tasks/{task_id}/photos/{photo_id}/delete')
    async def delete_photo(task_id:str,photo_id:str,request:Request):
        def apply(t):
            mutate_content(t,'photo_deleted',photo_id)
            photo=next((p for p in t['photos'] if p['id']==photo_id),None)
            if not photo:raise HTTPException(404,'照片不存在。')
            photo['deleted']=True
        return task_view(store.change('task',task_id,request.state.owner,apply))

    @app.post(prefix+'/tasks/{task_id}/components/{component_id}/rotate')
    async def rotate(task_id:str,component_id:str,request:Request):
        def apply(t):
            mutate_content(t,'component_rotated',component_id)
            c=next((c for c in active_components(t) if c['id']==component_id),None)
            if not c:raise HTTPException(404,'器件不存在。')
            folder=store.folder('task',task_id)
            c.setdefault('base_crop_file',c['crop_file'])
            c['orientation']=(c['orientation']+90)%360
            name=f"{c['id']}-r{t['revision']}.png"
            with Image.open(folder/c['base_crop_file']) as image:
                image.rotate(-c['orientation'],expand=True).save(folder/name)
            c.update(crop_file=name,analysis=None,review=None,error=None,raw_output=None,model_metadata=None,technical_error=None)
            c['transform']['user_rotation_clockwise']=c['orientation']
        async with image_slot:
            return task_view(await asyncio.to_thread(store.change,'task',task_id,request.state.owner,apply))

    @app.post(prefix+'/tasks/{task_id}/components/{component_id}/review')
    async def review(task_id:str,component_id:str,data:ReviewInput,request:Request):
        person=profile(request.state.owner)
        def apply(t):
            mutate_content(t,'component_reviewed',component_id+': '+data.verdict)
            c=next((c for c in active_components(t) if c['id']==component_id),None)
            if not c:raise HTTPException(404,'器件不存在。')
            if not c['analysis'] and not c['error']:raise HTTPException(409,'请先识别这个器件。')
            c['review']={**data.model_dump(),'at':time.time(),'operator':{k:person[k] for k in ('employee_id','name','identity_source')}}
        return task_view(store.change('task',task_id,request.state.owner,apply))

    @app.post(prefix+'/tasks/{task_id}/analyze')
    async def analyze(task_id:str,data:AnalyzeInput,request:Request):
        return task_view(await service.start(task_id,request.state.owner,data.model_id))

    @app.post(prefix+'/tasks/{task_id}/stop')
    async def stop(task_id:str,request:Request):
        return task_view(await service.stop(task_id,request.state.owner))

    @app.post(prefix+'/tasks/{task_id}/writeback')
    async def writeback(task_id:str,data:RevisionInput,request:Request):
        return task_view(await service.submit(task_id,request.state.owner,data.revision))

    @app.get(prefix+'/tasks/{task_id}/export')
    async def export(task_id:str,request:Request):
        task=store.get('task',task_id,request.state.owner)
        folder=store.folder('task',task_id)
        def build():
            _,files=export_files(task,folder)
            path=folder/f"inspection-{task_id}-r{task['revision']}.zip"
            temporary=folder/(ident()+'.zip.tmp')
            with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_STORED) as out:
                for f in files:out.write(f['path'],f['name'])
                ref=task['reference']
                if ref.get('crop_file'):
                    ref_folder=store.folder('reference',ref['id'])
                    out.write(ref_folder/ref['crop_file'],'reference/'+ref['crop_file'])
                    original=ref.get('photo',{}).get('original_file')
                    if original:out.write(ref_folder/original,'reference/'+original)
            temporary.replace(path)
            return path
        path=await asyncio.to_thread(build)
        return FileResponse(path,filename=path.name,media_type='application/zip')

    @app.get(prefix+'/files/{kind}/{key}/{name}')
    async def file(kind:str,key:str,name:str,request:Request):
        if kind not in ('task','reference') or Path(name).name!=name:raise HTTPException(404)
        item=store.get(kind,key,request.state.owner)
        photos=item['photos'] if kind=='task' else [item.get('photo',{})]
        allowed=set()
        for p in photos:
            allowed.update(p[k] for k in ('original_file','preview_file','annotation_file') if k in p)
            allowed.update(c['crop_file'] for c in p.get('components',[]))
        if item.get('crop_file'):allowed.add(item['crop_file'])
        if name not in allowed:raise HTTPException(404)
        return FileResponse(store.folder(kind,key)/name)

    @app.post(prefix+'/demo')
    async def demo(request:Request):
        owner=request.state.owner
        if not profile(owner):raise HTTPException(409,'请先填写试用检验员，再加载样例。')
        fixtures=Path(__file__).resolve().parents[5]/'fixtures'/'inspection'
        if not (fixtures/'reference.png').exists():raise HTTPException(404,'当前安装不含合成测试素材。')
        ref=await add_reference(owner,'合成样例 · SV358','SV358\nA26\n0147','',True,(fixtures/'reference.png').read_bytes(),True)
        task=add_task(owner,TaskInput(number='DEMO-'+time.strftime('%m%d%H%M%S')+'-'+ident()[:4],material='虚构 SOIC-8 · 仅测试',expected_count=4,reference_id=ref['id'],capture_mode='multi'),True)
        return task_view(await add_photo(task['id'],owner,(fixtures/'four-components.png').read_bytes(),ident()))

    return service

"""独立 MES 合同接收示例。只供本机/测试环境联调，不冒充企业登录。"""
from __future__ import annotations
import argparse
import hashlib
import secrets
import time
from pathlib import Path
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from .mes import canonical
from .storage import InspectionStore
from .routes import read_upload


def create_mock_mes(root:Path,token:str):
    if len(token)<16:raise ValueError('模拟 MES 的服务令牌至少 16 位。')
    store=InspectionStore(root)
    app=FastAPI(title='SmartVerifier MES 接收合同示例',version='1.0')
    app.state.store=store

    @app.middleware('http')
    async def auth(request:Request,call_next):
        if request.url.path.startswith('/v1/') and not secrets.compare_digest(request.headers.get('authorization',''), 'Bearer '+token):
            return JSONResponse({'detail':'服务身份无效'},status_code=401)
        return await call_next(request)

    @app.post('/v1/attachments',status_code=201)
    async def attachment(file:UploadFile=File(...),sha256:str=Form(...),role:str=Form(...),idempotency_key:str=Header(...)):
        if role not in ('original_photo','annotated_photo','sample_crop','structured_report'):raise HTTPException(400,'附件角色无效')
        data=await read_upload(file)
        actual=hashlib.sha256(data).hexdigest()
        if sha256!=actual:raise HTTPException(422,'SHA-256 不一致')
        key=hashlib.sha256(idempotency_key.encode()).hexdigest()
        existing=next((a for a in store.list('attachment','mes') if a['id']==key),None)
        if existing:
            if existing['sha256']!=sha256 or existing['role']!=role:raise HTTPException(409,'幂等键内容冲突')
            return {'attachment_id':key,'sha256':sha256}
        folder=store.folder('blobs',key);(folder/'data').write_bytes(data)
        store.create('attachment','mes',{'id':key,'sha256':sha256,'role':role,'size':len(data),'name':file.filename})
        return {'attachment_id':key,'sha256':sha256}

    @app.get('/v1/submissions/{key}')
    async def submission(key:str):
        return store.get('submission',hashlib.sha256(key.encode()).hexdigest(),'mes')['receipt']

    @app.put('/v1/quality-inspections/{task_id}/items/{item_id}/result')
    async def result(task_id:str,item_id:str,request:Request,if_match:str=Header(...),idempotency_key:str=Header(...)):
        body=await request.json()
        required={'schema_version','source_task_id','report_revision','mes_task_id','item_id','expected_item_version','operator','material','conclusion','sample_count','failed_count','photo_count','attachments'}
        if not isinstance(body,dict) or not required.issubset(body):raise HTTPException(422,'缺少结果字段')
        if body.get('schema_version')!='1.0' or body.get('save_mode')!='item_draft' or body.get('final_submit') is not False:
            raise HTTPException(422,'只接受 1.0 项目级暂存，禁止整单提交')
        if body['mes_task_id']!=task_id or body['item_id']!=item_id or '"'+str(body['expected_item_version'])+'"'!=if_match:
            raise HTTPException(422,'任务或版本标识不一致')
        try:
            total,failed,photos=(body[k] for k in ('sample_count','failed_count','photo_count'))
            assert all(type(n) is int for n in (total,failed,photos)) and 1<=total<=100 and 0<=failed<=total and 1<=photos<=100
            assert body['conclusion']==('FAIL' if failed else 'PASS')
            assert body['operator']['employee_id'] and body['operator']['identity_source'] in ('local_trial','mes_verified')
            attachments=body['attachments'];assert isinstance(attachments,list) and len(attachments)<=400
            assert sum(a['role']=='original_photo' for a in attachments)==photos
            assert sum(a['role']=='structured_report' for a in attachments)==1
            for a in attachments:
                known=store.get('attachment',a['attachment_id'],'mes')
                assert (known['sha256'],known['role'],known['size'])==(a['sha256'],a['role'],a['size'])
        except (KeyError,TypeError,AssertionError,HTTPException):raise HTTPException(422,'计数、身份或附件不完整')
        key=hashlib.sha256(idempotency_key.encode()).hexdigest();digest=hashlib.sha256(canonical(body)).hexdigest()
        item_key=hashlib.sha256((task_id+'\n'+item_id).encode()).hexdigest()
        # 同一事务原子更新检测项和回执；丢失响应后可以安全查询。
        import json
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute("SELECT body FROM documents WHERE kind='submission' AND id=?",(key,)).fetchone()
            if row:
                old=json.loads(row[0])
                if old['digest']!=digest:raise HTTPException(409,'同一幂等键的报告不同')
                return old['receipt']
            row=db.execute("SELECT body FROM documents WHERE kind='mes_item' AND id=?",(item_key,)).fetchone()
            previous=json.loads(row[0]) if row else {'version':'0'}
            if '"'+previous['version']+'"'!=if_match:raise HTTPException(412,'检测项版本冲突')
            version=str(int(previous['version'])+1);now=time.time()
            receipt={'receipt_id':'HTTP-MOCK-'+key[:14],'status':'saved','mode':'http_mock','saved_at':now,
                     'item_version':version,'final_submission':False}
            for kind,record_id,record in [('mes_item',item_key,{'version':version,'payload':body}),('submission',key,{'digest':digest,'receipt':receipt})]:
                db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?,?,?)',(kind,record_id,'mes',json.dumps(record,ensure_ascii=False),now))
        return receipt

    return app


def main():
    import os,uvicorn
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state',type=Path,required=True);parser.add_argument('--port',type=int,default=5199)
    args=parser.parse_args();token=os.environ.get('SV_MOCK_MES_TOKEN','')
    uvicorn.run(create_mock_mes(args.state,token),host='127.0.0.1',port=args.port,access_log=False)


if __name__=='__main__':main()

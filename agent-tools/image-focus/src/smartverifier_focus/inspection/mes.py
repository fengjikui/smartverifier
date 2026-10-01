"""MES 项目级保存契约。默认本地模拟，真实端点须显式配置。"""
from __future__ import annotations
import asyncio
import hashlib
import json
import os
import re
from pathlib import Path
import time
from urllib.parse import quote,urlparse
import httpx


class MesError(RuntimeError):
    pass


def checked_receipt(receipt):
    if (receipt.get('status')!='saved' or not receipt.get('receipt_id')
        or receipt.get('final_submission') is not False or not isinstance(receipt.get('item_version'),str)
        or not re.fullmatch(r'[A-Za-z0-9._:-]{1,100}',receipt['item_version'])):
        raise MesError('MES 回执不符合“只保存检测项”的约定。')
    return receipt


def canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()


class LocalMesAdapter:
    mode='mock'
    def __init__(self, root):
        self.root=Path(root)/'mes-receiver'
        self.root.mkdir(parents=True,exist_ok=True)
    async def send(self,payload,files,key):
        path=self.root/(hashlib.sha256(key.encode()).hexdigest()+'.json')
        digest=hashlib.sha256(canonical(payload)).hexdigest()
        if path.exists():
            old=json.loads(path.read_text())
            if old['payload_sha256']!=digest:raise MesError('同一幂等键的内容发生变化。')
            return old['receipt']
        attachments=[]
        destination=self.root/hashlib.sha256(key.encode()).hexdigest()
        destination.mkdir(exist_ok=True)
        for f in files:
            data=f['path'].read_bytes()
            sha=hashlib.sha256(data).hexdigest()
            if sha!=f['sha256']:raise MesError('附件校验不一致。')
            (destination/f['name']).write_bytes(data)
            attachments.append({k:v for k,v in f.items() if k!='path'})
        receipt={'receipt_id':'MOCK-'+hashlib.sha256(key.encode()).hexdigest()[:14],
                 'status':'saved','mode':'mock','item_version':str(int(time.time()*1000)),
                 'saved_at':time.time(),'final_submission':False}
        record={'payload_sha256':digest,'payload':payload,'attachments':attachments,'receipt':receipt}
        temp=path.with_suffix('.tmp');temp.write_bytes(canonical(record));temp.replace(path)
        return receipt


class HttpMesAdapter:
    mode='http'
    def __init__(self,url,token,*,transport=None):
        parsed=urlparse(url)
        if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('MES 地址应为不含凭证的 HTTP(S) 服务根地址。')
        if parsed.scheme!='https' and parsed.hostname not in ('127.0.0.1','localhost'):
            raise ValueError('真实 MES 必须使用 HTTPS。')
        self.url=url.rstrip('/');self.token=token;self.transport=transport
        self.loopback=parsed.hostname in ('127.0.0.1','localhost')
    async def send(self,payload,files,key):
        if not self.loopback and payload['operator']['identity_source']!='mes_verified':
            raise MesError('真实 MES 需要经过验证的检验员身份；当前为本地试用身份。')
        if not self.loopback and payload.get('synthetic_test'):
            raise MesError('合成测试资料不能回填到真实 MES。')
        headers={'Authorization':f'Bearer {self.token}','Idempotency-Key':key}
        async with httpx.AsyncClient(base_url=self.url+'/',headers=headers,timeout=30,
                                     transport=self.transport,trust_env=False,follow_redirects=False) as client:
            # 重试先查回执：处理“MES 已保存，但上次响应丢失”的情况。
            check=await client.get('v1/submissions/'+quote(key,safe=''))
            if check.status_code==200:
                receipt=check.json()
                return checked_receipt(receipt)
            if check.status_code!=404:
                raise MesError(f'MES 回执查询失败（HTTP {check.status_code}）。')
            attachments=[]
            for item in files:
                with item['path'].open('rb') as stream:
                    r=await client.post('v1/attachments',headers={'Idempotency-Key':key+':'+item['sha256']},
                        data={'sha256':item['sha256'],'role':item['role']},
                        files={'file':(item['name'],stream,item['mime'])})
                if r.status_code not in (200,201):raise MesError(f'附件保存失败（HTTP {r.status_code}）。')
                body=r.json()
                if body.get('sha256')!=item['sha256'] or not body.get('attachment_id'):
                    raise MesError('MES 附件回执缺少 ID 或校验值不符。')
                attachments.append({'attachment_id':body['attachment_id'],**{k:v for k,v in item.items() if k!='path'}})
            document={**payload,'attachments':attachments}
            endpoint='v1/quality-inspections/'+quote(payload['mes_task_id'],safe='')+'/items/'+quote(payload['item_id'],safe='')+'/result'
            version=payload['expected_item_version']
            if not re.fullmatch(r'[A-Za-z0-9._:-]{1,100}',version):raise MesError('检测项版本格式无效。')
            r=await client.put(endpoint,json=document,headers={'If-Match':'"'+version+'"'})
            if r.status_code in (409,412):raise MesError('MES 任务版本或状态发生变化，请确认后再回填，系统没有覆盖原数据。')
            if r.status_code not in (200,201):raise MesError(f'MES 未确认保存（HTTP {r.status_code}），可使用同一记录重试。')
            receipt=r.json()
            return checked_receipt(receipt)


def adapter_from_env(root):
    url=os.environ.get('SV_MES_URL','')
    if not url:return LocalMesAdapter(root)
    token=os.environ.get('SV_MES_TOKEN','')
    if not token:raise ValueError('配置 SV_MES_URL 时必须提供服务端 SV_MES_TOKEN。')
    return HttpMesAdapter(url,token)

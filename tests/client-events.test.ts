import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.ts';

test('拍摄诊断：未登录拒绝；保留阶段、尺寸和处理编号，拒绝照片内容字段',async t=>{
 const state=await mkdtemp(path.join(tmpdir(),'sv-camera-diagnostics-')),{server,service,admin}=startServer({state,host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port+'/api/v1/inspections/marking';t.after(async()=>{admin.files.close();service.closing=true;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));service.store.close();await rm(state,{recursive:true,force:true});});
 let cookie='';async function post(data:unknown){return fetch(base+'/client-events',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(data)});}
 const event={at:new Date().toISOString(),phase:'canvas-complete',captureId:'test-capture',bytes:1200,width:640,height:480,ms:25};assert.equal((await post({events:[event]})).status,401);
 const session=await fetch(base+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});cookie=session.headers.get('set-cookie')!.split(';')[0];assert.equal((await post({events:[event]})).status,200);assert.equal((await post({events:[{...event,image:'data:image/png;base64,NOT_ALLOWED'}]})).status,400);
 const rows=(await readFile(path.join(state,'diagnostics/camera.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.equal(rows.length,1);assert.equal(rows[0].captureId,event.captureId);assert.equal(rows[0].actorId,'QA018');assert.equal(rows[0].bytes,1200);assert.ok(!('image'in rows[0]));
});

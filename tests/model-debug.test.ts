import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { TraceStore } from '../server/vision/trace-store.ts';
import { startServer } from '../server/index.ts';
import { LocalVisionPipeline } from '../server/vision/local-pipeline.ts';
import type { TraceEvent } from '../shared/model-trace.ts';

test('调试记录增量读取忽略未写完的尾行，校验标记幂等且图片路径不接受穿越',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'sv-trace-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new TraceStore(dir),id=randomUUID();await mkdir(store.folder(id));
  const first={seq:1,type:'request',elapsedMs:0,at:Date.now()/1000,model:'fixture',componentIds:['C01']};const file=path.join(store.folder(id),'events.ndjson');
  await writeFile(file,JSON.stringify(first)+'\n'+JSON.stringify({seq:2,type:'fragment',elapsedMs:5,at:Date.now()/1000}));assert.equal((await store.read(id)).length,1);
  await appendFile(file,'\n');assert.equal((await store.read(id)).length,2);await store.finish(id,false,'缺项');await store.finish(id,true,'不得覆盖');
  assert.equal((await store.read(id)).filter(e=>e.type==='validation').length,1);assert.equal((await store.list())[0].status,'invalid');assert.throws(()=>store.folder('../outside'));
});

test('调试HTTP要求会话、可增量查看、图片原样返回，样例隔离且并发不抢占',async t=>{
  const state=await mkdtemp(path.join(tmpdir(),'sv-debug-api-')),root=process.cwd();const pipeline=new LocalVisionPipeline(root,state,{traceDirectory:path.join(state,'vision-traces')});
  const store=new TraceStore(pipeline.traceDirectory!);let release:()=>void=()=>{},requestData:Record<string,unknown>={};
  pipeline.worker=async request=>{requestData=request;const id=String(request.traceId);await mkdir(store.folder(id),{recursive:true});await writeFile(path.join(store.folder(id),'image-0.png'),Buffer.from('actual fixture bytes'));
    await writeFile(path.join(store.folder(id),'events.ndjson'),JSON.stringify({seq:1,type:'request',at:Date.now()/1000,elapsedMs:0,model:'fixture',componentIds:request.componentIds})+'\n');
    await new Promise<void>(resolve=>{release=resolve;});const ids=request.componentIds as string[];
    return {response:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:ids.map(componentId=>({componentId,status:'decided',verdict:'PASS',lines:['x'],confidence:.8,reason:'fixture',features:[],differences:[]})),instructionConflicts:[]})}}]}};
  };
  const {server,service}=startServer({state,port:0,host:'127.0.0.1',vision:pipeline,debug:true});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  t.after(async()=>{release();service.closing=true;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));service.store.close();await rm(state,{recursive:true,force:true});});
  assert.equal((await fetch(base+'/api/v1/inspections/marking/debug/traces')).status,401);const login=await fetch(base+'/api/v1/inspections/marking/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  const headers={'Cookie':cookie,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/v1/inspections/marking/debug/samples',{method:'POST',headers:{...headers,Origin:'https://other.example'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/v1/inspections/marking/debug/traces',{headers:{...headers,'X-Forwarded-For':'192.168.1.5'}})).status,403);
  const initial=(await fetch(base+'/api/v1/inspections/marking/bootstrap',{headers}));const before=await initial.json();
  const response=await fetch(base+'/api/v1/inspections/marking/debug/samples',{method:'POST',headers,body:JSON.stringify({mode:'board4',format:'json-schema'})});assert.equal(response.status,202);const {id}=await response.json();
  for(let i=0;i<50;i++){try{await readFile(path.join(store.folder(id),'events.ndjson'));break;}catch{await new Promise(resolve=>setTimeout(resolve,5));}}
  assert.equal((requestData.responseSchema as {properties:{items:{maxItems:number}}}).properties.items.maxItems,4);
  assert.equal(requestData.inputLayout,'prefix-first');
  assert.equal((await fetch(base+'/api/v1/inspections/marking/debug/samples',{method:'POST',headers,body:JSON.stringify({mode:'board6',format:'prompt-json'})})).status,409);
  assert.equal((await fetch(base+'/api/v1/inspections/marking/debug/traces/'+id+'/images/0.png')).status,401);
  assert.equal(await(await fetch(base+'/api/v1/inspections/marking/debug/traces/'+id+'/images/0.png',{headers})).text(),'actual fixture bytes');
  const events=await(await fetch(base+'/api/v1/inspections/marking/debug/traces/'+id+'?after=1',{headers})).json();assert.deepEqual(events.events,[]);
  release();for(let i=0;i<100;i++){const events:TraceEvent[]=await store.read(id);if(events.some(e=>e.type==='validation'))break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal((await store.list())[0].status,'valid');const after=await(await fetch(base+'/api/v1/inspections/marking/bootstrap',{headers})).json();assert.deepEqual(before.tasks,after.tasks);
  const health=await(await fetch(base+'/api/v1/inspections/marking/health')).json();assert.deepEqual(health.visionConfiguration,{inputLayout:'prefix-first',outputFormat:'json-schema'});
});

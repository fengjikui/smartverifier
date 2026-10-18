import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalVisionPipeline } from '../server/vision/local-pipeline.ts';
import { InspectionService, person } from '../server/service.ts';
import { TraceStore } from '../server/vision/trace-store.ts';

test('公司兼容VLM通过真实HTTP及Python工作器跑通识别、报告和模拟回填；错误不降级或泄漏密钥',async t=>{
  const state=await mkdtemp(path.join(tmpdir(),'sv-vlm-http-')),root=process.cwd(),apiKey='test-only-dummy-vlm-token';
  let calls=0,mode:'ok'|'reject'='ok',payload:Record<string,any>={},auth='';
  const upstream=http.createServer(async(req,res)=>{
    calls++;auth=req.headers.authorization??'';assert.equal(req.url,'/v1/chat/completions');
    let text='';for await(const chunk of req)text+=chunk;payload=JSON.parse(text);
    if(mode==='reject'){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:apiKey+' should not be echoed'}}));return;}
    const id=payload.response_format.json_schema.schema.properties.items.items.properties.componentId.enum[0];
    const output=JSON.stringify({items:[{componentId:id,status:'decided',verdict:'PASS',lines:['SV358','A26','0147'],confidence:.91,reason:'测试协议返回，非真实模型判断',features:[],differences:[]}],instructionConflicts:[]});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const part of [output.slice(0,20),output.slice(20)])res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:part},finish_reason:null}]})+'\n\n');
    res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');
    res.end('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:500,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const addr=upstream.address();assert.ok(addr&&typeof addr!=='string');
  const pipeline=new LocalVisionPipeline(root,state,{provider:'openai-compatible',endpoint:`http://127.0.0.1:${addr.port}/v1`,model:'company-fixture',apiKey,timeoutSeconds:5,traceDirectory:path.join(state,'vision-traces')});
  const service=new InspectionService(state,root,1,pipeline);
  t.after(async()=>{service.closing=true;pipeline.close();while(service.worker)await delay(10);service.store.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));await rm(state,{recursive:true,force:true});});
  let view=service.open('REALVISION1');view=await service.addRealTrial(view.round!.id,view.round!.revision,person);
  service.analyze(view.round!.id,view.round!.revision);while(service.worker)await delay(25);view=service.view('REALVISION1');
  assert.equal(view.summary!.pass,1);assert.equal(view.summary!.canSubmit,true);assert.equal(view.round!.photos[0].components[0].ai!.source,'vlm');
  assert.equal(auth,'Bearer '+apiKey);assert.equal(payload.model,'company-fixture');assert.equal(payload.response_format.type,'json_schema');
  assert.deepEqual(payload.messages.map((m:{role:string})=>m.role),['system','user','assistant','user']);
  assert.ok(payload.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));
  const traces=new TraceStore(pipeline.traceDirectory!),entries=await traces.list(),events=await traces.read(entries[0].id);
  assert.equal(events.filter(e=>e.type==='item_complete').length,1);assert.equal(JSON.stringify(events).includes(apiKey),false);
  assert.match(service.report(view.round!),/VLM真实识别/);
  service.submit(view.round!.id,view.round!.revision,person,true);while(service.view('REALVISION1').round!.status==='submitting')await delay(10);
  view=service.view('REALVISION1');assert.equal(view.round!.status,'submit_failed');const key=view.round!.transfer!.key;
  service.submit(view.round!.id,view.round!.revision,person);while(service.view('REALVISION1').round!.status==='submitting')await delay(10);
  view=service.view('REALVISION1');assert.equal(view.round!.status,'submitted');assert.equal(view.effective!.id,view.round!.id);assert.equal(view.round!.transfer!.key,key);
  assert.ok((await readFile(path.join(state,'reports',view.round!.id+'.md'),'utf8')).includes('company-fixture'));
  mode='reject';const before=calls,photo=view.round!.photos[0],component=photo.components[0];
  await assert.rejects(pipeline.recognize(view.round!,photo,component),error=>error instanceof Error&&error.message.includes('HTTP 400')&&!error.message.includes(apiKey));
  assert.equal(calls,before+1,'不自动重试或偷偷取消Schema');
  for(const entry of await traces.list())assert.equal(JSON.stringify(await traces.read(entry.id)).includes(apiKey),false);
});

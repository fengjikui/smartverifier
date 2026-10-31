import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { runStarter,selectStarterRoute,requireOcrEvidence } from '../server/vision/starter.ts';
import { validateOcrResult } from '../server/vision/ocr-contracts.ts';
import { startServer } from '../server/index.ts';
import { apiPath,markingPaths } from '../shared/paths.ts';
const root=path.resolve('.');
test('默认整图VLM与分割VLM独立；开启分割不强制使用轻量OCR',async()=>{
 const original=await runStarter(root,{});assert.equal(original.mode,'mock');assert.equal(original.separation,null);assert.equal(original.route.selected,'vlm');assert.equal(original.ocr.length,0);assert.equal(original.stages[1].state,'skipped');assert.deepEqual(original.reply.items.map(i=>i.verdict),['PASS','FAIL']);assert.ok(original.reply.items.every(i=>i.confidence===null));
 const separated=await runStarter(root,{separate:true,backend:'vlm'});assert.equal(separated.route.selected,'vlm');assert.equal(separated.separation!.components.length,2);assert.equal(separated.ocr.length,0);
 for(const c of separated.separation!.components){const m=c.viewToUprightOriginal;assert.deepEqual([m[2],m[5]],c.quadPx[0]);assert.equal(c.quality.state,'undetermined');}
});
test('轻量OCR模拟经过真实合同校验，输入输出按ID与哈希对应，不写伪置信度',async()=>{
 const run=await runStarter(root,{separate:true,backend:'lightweight'});assert.equal(run.ocr.length,2);assert.deepEqual(run.ocr.map(r=>r.lines[0].text),['SV358','SV385']);
 run.ocr.forEach((r,i)=>{assert.equal(r.componentId,run.ocrRequests[i].componentId);assert.equal(r.inputSha256,run.ocrRequests[i].image.sha256);assert.equal(r.lines[0].score,null);});
 await assert.rejects(()=>runStarter(root,{separate:false,backend:'lightweight'}),/开启前置分割/);
 await assert.rejects(()=>runStarter(root,{backend:'other'}));await assert.rejects(()=>runStarter(root,{endpoint:'http://anything'}));
});
test('路由参考有缺省与能力门槛，歧义和低把握只改推荐，不生成重拍或不合格',async()=>{
 for(const reference of ['clear','ambiguous','low-confidence','unknown'] as const){const r=await runStarter(root,{separate:true,backend:'auto',reference});assert.equal(r.route.selected,reference==='clear'?'lightweight':'vlm');assert.deepEqual(r.reply.items.map(i=>i.verdict),['PASS','FAIL']);}
 assert.equal((await runStarter(root,{backend:'auto'})).route.selected,'vlm');
 assert.equal(selectStarterRoute({separate:true,backend:'auto',reference:'clear'},{quality:'poor',confidence:.98,ambiguities:[]}).selected,'vlm');
 assert.equal((await runStarter(root,{separate:true,backend:'lightweight',reference:'ambiguous'})).route.selected,'lightweight','手动选择不被自动路由覆盖');
});
test('OCR拒绝迟到、错误哈希、越界／退化坐标和伪装成功；空读文不伪装模糊',async()=>{
 const run=await runStarter(root,{separate:true,backend:'lightweight'}),request=run.ocrRequests[0],result=run.ocr[0];
 for(const patch of [{photoVersion:2},{componentId:'other'},{requestId:'old'},{sourceSha256:'0'.repeat(64)},{inputSha256:'0'.repeat(64)}])assert.throws(()=>validateOcrResult(request,{...result,...patch}));
 const bad=structuredClone(result);bad.lines[0].quadPx[0][0]=request.image.width+1;assert.throws(()=>validateOcrResult(request,bad),/超出/);
 bad.lines[0].quadPx=[[0,0],[1,1],[0,1],[1,0]];assert.throws(()=>validateOcrResult(request,bad),/非退化/);
 assert.throws(()=>validateOcrResult(request,{...result,state:'failed'}),/失败状态/);
 assert.throws(()=>validateOcrResult(request,{...result,error:{code:'error',message:'错误'}}),/失败状态/);
 assert.deepEqual(validateOcrResult(request,{...result,lines:[]}).lines,[]);
 assert.throws(()=>requireOcrEvidence({...result,lines:[]}),/不是图片模糊或不合格/);
 assert.throws(()=>requireOcrEvidence({...result,state:'failed',lines:[],error:{code:'MODEL_ERROR',message:'不可用'}}),/改选VLM/);
 assert.equal(validateOcrResult(request,{...result,state:'failed',lines:[],error:{code:'MODEL_ERROR',message:'OCR失败不是模糊结论'}}).state,'failed');
});
test('CLI在中文带空格路径导出图片与JSON，重复执行不覆盖，错误立即非零退出',async t=>{
 const output=await mkdtemp(path.join(tmpdir(),'鉴微 联调样例 '));t.after(()=>rm(output,{recursive:true,force:true}));
 const exec=promisify(execFile),args=[path.join(root,'scripts/vision-starter.ts'),'--separate','--backend','lightweight','--out',output];
 const first=await exec(process.execPath,args,{cwd:tmpdir(),encoding:'utf8'}),second=await exec(process.execPath,args,{cwd:tmpdir(),encoding:'utf8'});
 const directory=first.stdout.trim().split('图片、输入输出JSON已保存：')[1];assert.ok(directory);assert.notEqual(first.stdout,second.stdout);
 const run=JSON.parse(await readFile(path.join(directory,'run.json'),'utf8'));assert.equal(run.mode,'mock');assert.ok((await readFile(path.join(directory,'crop-2.png'))).length>100);
 const assets=JSON.parse(await readFile(path.join(directory,'assets.json'),'utf8'));assert.equal(assets[run.input.original.assetId],'original.png');assert.equal(assets[run.separation.components[1].modelView.assetId],'crop-2.png');assert.equal(assets[run.basis.referenceImage.assetId],'reference.png');assert.ok((await readFile(path.join(directory,'reference.png'))).length>100);
 assert.equal(JSON.parse(await readFile(path.join(directory,'ocr-1.output.json'),'utf8')).componentId,'starter-c1');
 await assert.rejects(()=>exec(process.execPath,[args[0],'--backend','lightweight'],{cwd:tmpdir()}));
});
test('联调API限已登录本机，经过代理拒绝；模拟运行不创建照片／任务或调用模型',async t=>{
 const state=await mkdtemp(path.join(tmpdir(),'sv-starter-api-'));let modelCalls=0;
 const vision:any={model:'must-not-call',prepare:()=>{modelCalls++;throw Error('不能调用模型');},recognize:()=>{modelCalls++;throw Error('不能调用模型');}};
 const {server,service,admin}=startServer({state,host:'127.0.0.1',port:0,debug:true,vision});await once(server,'listening');const addr=server.address();assert.ok(addr&&typeof addr!=='string');const base='http://127.0.0.1:'+addr.port;
 t.after(async()=>{service.closing=true;admin.files.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));service.store.close();await rm(state,{recursive:true,force:true});});
 const endpoint=base+apiPath('/debug/vision-starter');assert.equal((await fetch(endpoint)).status,401);
 const login=await fetch(base+apiPath('/session'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),cookie=login.headers.get('set-cookie')!.split(';')[0],headers={Cookie:cookie,'Content-Type':'application/json'};
 const rounds=service.store.rounds().length,tasks=service.store.tasks().length;
 assert.equal((await fetch(base+markingPaths.visionStarter)).status,200);
 assert.equal((await fetch(endpoint,{headers:{...headers,'X-Forwarded-For':'127.0.0.1'}})).status,403);
 const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({separate:true,backend:'lightweight'})});assert.equal(response.status,200);assert.equal((await response.json()).mode,'mock');
 const incompatible=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({backend:'lightweight'})});assert.equal(incompatible.status,409);assert.match((await incompatible.json()).message,/开启前置分割/);
 assert.equal((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({separate:true,backend:'lightweight',model:'real'})})).status,400);
 assert.equal((await fetch(endpoint+'/assets/crop-1',{headers})).headers.get('content-type'),'image/png');
 assert.equal((await fetch(endpoint+'/assets/secret',{headers})).status,404);assert.equal(modelCalls,0);assert.equal(service.store.rounds().length,rounds);assert.equal(service.store.tasks().length,tasks);
});

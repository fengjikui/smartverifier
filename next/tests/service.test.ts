import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.ts';
import { InspectionService } from '../server/service.ts';
import type { TaskView } from '../shared/types.ts';

test('真实HTTP与SQLite：增量、改判、重新判定、质量替换、幂等回填及历史保护',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-next-test-'));
  const {server,service}=startServer({state:directory,port:0,host:'127.0.0.1',delay:5});
  await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  t.after(async()=>{service.closing=true;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await delay(20);service.store.close();await rm(directory,{recursive:true,force:true});});
  let cookie='';
  async function call<T=TaskView>(route:string,body?:unknown,expected=200):Promise<T>{const response=await fetch(base+'/api/v1/inspections/marking'+route,{method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(body instanceof FormData?{}:body===undefined?{}:{'Content-Type':'application/json'})},body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});assert.equal(response.status,expected,route+': '+response.status);return await response.json() as T;}
  await call('/bootstrap',undefined,401);
  const login=await fetch(base+'/api/v1/inspections/marking/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];assert.ok(cookie.startsWith('sv_next_session='));
  const missing=await call('/tasks/IQCF26090500018/open',{});assert.equal(missing.round,null);assert.equal(missing.task.standard,null);
  let view=await call('/tasks/IQCF26090500016/open',{});
  async function change(name:string,body:Record<string,unknown>={},expected=200){const result=await call('/rounds/'+view.round!.id+'/'+name,{revision:view.round!.revision,...body},expected);if(expected<300)view=result;return result;}
  async function wait(status:string){for(let i=0;i<150;i++){view=await call('/tasks/'+view.task.id);if(view.round!.status===status)return;await delay(10);}assert.fail('等待状态超时 '+status);}
  await change('submit',{},409);
  await change('sample',{sample:'four'});assert.equal(view.round!.photos.length,1);assert.equal(view.summary!.canSubmit,false);
  await change('analyze',{},202);await wait('ready');assert.equal(view.summary!.total,4);assert.equal(view.summary!.fail,1);assert.equal(view.summary!.lowConfidence,1);assert.equal(view.summary!.canSubmit,true);
  const original=structuredClone(view.round!.photos[0]);
  await change('sample',{sample:'pass'});assert.equal(view.summary!.completed,4);assert.equal(view.summary!.canSubmit,false);
  await change('submit',{},409);await change('analyze',{},202);await wait('ready');assert.equal(view.summary!.total,5);assert.equal(view.summary!.fail,1);assert.deepEqual(view.round!.photos[0],original,'增量检测不得改写先前结果');
  const bad=view.round!.photos[0].components[2];const stale=view.round!.revision;
  await change('review',{componentId:bad.id,verdict:'PASS',reason:'AI识别错误，已核对实物'});assert.equal(view.summary!.fail,0);assert.equal(view.summary!.verdict,'PASS');assert.equal(view.round!.photos[0].components[2].ai!.verdict,'FAIL');assert.equal(view.round!.photos[0].components[2].review!.person.id,'QA018');
  await call('/rounds/'+view.round!.id+'/review',{revision:stale,componentId:bad.id,verdict:'FAIL',reason:'旧请求'},409);
  await change('notes',{instruction:'批次号允许变化，重点核对型号。'});assert.equal(view.summary!.completed,0);assert.equal(view.round!.photos[0].components[2].review,null);assert.equal(view.round!.photos[0].components[2].reviewHistory.length,1);assert.equal(view.round!.photos[0].components[2].aiHistory[0].verdict,'FAIL');
  await change('analyze',{},202);await wait('ready');assert.equal(view.summary!.total,5);assert.equal(view.summary!.fail,1);assert.equal(view.round!.photos[0].components[2].aiHistory.length,2);
  const markdown=await fetch(base+'/api/v1/inspections/marking/rounds/'+view.round!.id+'/report.md',{headers:{Cookie:cookie}});assert.equal(markdown.status,200);const content=await markdown.text();assert.match(content,/本地模拟/);assert.match(content,/现场检测说明/);assert.match(content,/SV385/);
  await change('submit',{simulateFailure:true},202);await wait('submit_failed');assert.equal(view.effective,null);const key=view.round!.transfer!.key;
  await change('submit',{},202);await wait('submitted');assert.equal(view.round!.transfer!.key,key);assert.equal(view.effective!.id,view.round!.id);assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM receipts').get()!.n,1);
  await call('/rounds/'+view.round!.id+'/submit',{revision:1},202);assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM receipts').get()!.n,1);
  const oldId=view.round!.id,oldRound=structuredClone(service.store.round(view.round!.id)!);
  view=await call('/tasks/'+view.task.id+'/rounds',{reuse:true});assert.notEqual(view.round!.id,oldId);assert.equal(view.effective!.id,oldId);assert.equal(view.summary!.completed,0);
  await change('sample',{sample:'quality'});await change('analyze',{},202);await wait('draft');assert.equal(view.summary!.qualityPhotos,1);assert.equal(view.summary!.canSubmit,false);await change('submit',{},409);
  const quality=view.round!.photos.find(p=>p.status==='quality')!,oldSequence=quality.sequence;
  await change('sample',{sample:'pass',replaceId:quality.id});assert.equal(view.round!.photos.length,3);assert.equal(view.round!.photos.at(-1)!.sequence,oldSequence);
  await change('analyze',{},202);await wait('ready');assert.equal(view.summary!.total,6);assert.equal(view.summary!.fail,1);
  const bytes=await readFile(fileURLToPath(new URL('../../fixtures/inspection/reference.png',import.meta.url)));
  const modified=Buffer.concat([bytes,Buffer.from('non-fixture')]);const clientId=crypto.randomUUID();const rev=view.round!.revision;
  function form(){const f=new FormData();f.set('photo',new File([modified],'真实上传测试.png',{type:'image/png'}));f.set('width','1536');f.set('height','1024');f.set('revision',String(rev));f.set('clientId',clientId);return f;}
  view=await call('/rounds/'+view.round!.id+'/photos',form());const count=view.round!.photos.length;
  view=await call('/rounds/'+view.round!.id+'/photos',form());assert.equal(view.round!.photos.length,count,'响应丢失后的同一上传重试不得重复加图');
  const uploaded=view.round!.photos.at(-1)!;
  assert.equal((await fetch(base+uploaded.url)).status,401);const image=await fetch(base+uploaded.url,{headers:{Cookie:cookie}});assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),modified,'原图必须原样保存');
  await change('analyze',{},202);await wait('draft');assert.equal(view.summary!.failedPhotos,1);assert.match(view.round!.photos.at(-1)!.message,/不会.*伪造/);assert.equal(view.summary!.canSubmit,false);
  await change('remove',{photoId:uploaded.id});assert.equal(view.summary!.canSubmit,true);
  await change('submit',{simulateFailure:true},202);await wait('submit_failed');assert.equal(view.effective!.id,oldId,'重检失败不得替换旧有效结果');assert.deepEqual(service.store.round(oldId),oldRound,'历史轮次不得被改写');
  await change('submit',{},202);await wait('submitted');assert.equal(view.effective!.id,view.round!.id);assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM receipts').get()!.n,2);
  const restored=new InspectionService(directory,path.resolve(fileURLToPath(new URL('../../',import.meta.url))),5);assert.equal(restored.view(view.task.id).effective!.id,view.round!.id);assert.equal(restored.store.round(oldId)!.photos[0].components[2].reviewHistory.length,1);restored.store.close();
  const blocked=await fetch(base+'/api/v1/inspections/marking/session',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
  assert.ok(Number(service.store.db.prepare("SELECT count(*) AS n FROM audit WHERE action='verdict.correct'").get()!.n)>=1);
});

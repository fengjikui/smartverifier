import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.ts';
import { sampleBox, twentySample } from '../shared/sample-presets.ts';
import type { TaskView } from '../shared/types.ts';

test('20件拼图资产与预设坐标一致，所有格子可独立定位且原样片不变',async()=>{
  const folder=fileURLToPath(new URL('../fixtures/inspection/',import.meta.url));
  const manifest=JSON.parse(await readFile(path.join(folder,'twenty-components.json'),'utf8'));
  const png=await readFile(path.join(folder,'twenty-components.png'));
  assert.equal(png.readUInt32BE(16),twentySample.width);assert.equal(png.readUInt32BE(20),twentySample.height);
  assert.equal(manifest.sha256,createHash('sha256').update(png).digest('hex'));
  assert.equal(manifest.components.length,20);
  assert.equal(manifest.components.filter((c:{expected:string})=>c.expected==='FAIL').length,4);
  for(const entry of manifest.components){assert.deepEqual(entry.bbox,sampleBox('twenty',entry.index));const [x,y,w,h]=entry.bbox;assert.ok(x>=0&&y>=0&&x+w<=1.000001&&y+h<=1.000001);}
  for(const [name,hash] of Object.entries(manifest.sources))assert.equal(createHash('sha256').update(await readFile(path.join(folder,name))).digest('hex'),hash);
});

test('真实API：20张照片及20件单图，完整统计、幂等添加、重判与替换',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-twenty-test-'));
  const {server,service}=startServer({state:directory,port:0,host:'127.0.0.1',delay:1});
  await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port+'/api/v1/inspections/marking';
  t.after(async()=>{service.closing=true;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await delay(20);service.store.close();await rm(directory,{recursive:true,force:true});});
  const login=await fetch(base+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const headers={Cookie:login.headers.get('set-cookie')!.split(';')[0],'Content-Type':'application/json'};
  async function call(route:string,body?:unknown,expected=200):Promise<TaskView>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});assert.equal(response.status,expected,route+': '+await response.clone().text());return await response.json() as TaskView;}
  let view=await call('/tasks/IQCF26090500016/open',{});
  async function change(action:string,values:Record<string,unknown>={},expected=200){const result=await call('/rounds/'+view.round!.id+'/'+action,{revision:view.round!.revision,...values},expected);if(expected<300)view=result;return result;}
  async function ready(){for(let i=0;i<250;i++){view=await call('/tasks/'+view.task.id);if(view.round!.status==='ready')return;await delay(10);}assert.fail('20件样例检测超时');}
  const originalRevision=view.round!.revision,clientId='twenty-photos-request';
  await change('sample-set',{clientId});assert.equal(view.round!.photos.length,20);assert.equal(new Set(view.round!.photos.map(p=>p.id)).size,20);
  assert.equal(new Set(view.round!.photos.map(p=>p.hash)).size,2,'重复的样例像素不合并拍摄意图');
  view=await call('/rounds/'+view.round!.id+'/sample-set',{revision:originalRevision,clientId});assert.equal(view.round!.photos.length,20);
  await change('submit',{},409);await change('analyze',{},202);await ready();
  assert.equal(view.summary!.total,20);assert.equal(view.summary!.fail,4);assert.equal(view.summary!.pass,16);assert.equal(view.summary!.canSubmit,true);
  const existing=structuredClone(view.round!.photos);
  await change('sample',{sample:'twenty'});const board=view.round!.photos.at(-1)!;assert.equal(board.width,2560);assert.equal(board.height,1600);
  await change('analyze',{},202);await ready();assert.deepEqual(view.round!.photos.slice(0,20),existing,'只检测新加的20件单图，不重判之前20张照片');
  assert.equal(view.summary!.total,40);assert.equal(view.summary!.fail,8);assert.equal(view.summary!.lowConfidence,3);
  const pieces=view.round!.photos.at(-1)!.components;assert.equal(pieces.length,20);assert.equal(pieces.at(-1)!.label,'P021-20');
  const ids=pieces.map(c=>c.id);await change('notes',{instruction:'测试重新判定，保留定位'});assert.equal(view.summary!.completed,0);
  await change('analyze',{},202);await ready();assert.deepEqual(view.round!.photos.at(-1)!.components.map(c=>c.id),ids);
  const report=await (await fetch(base+'/rounds/'+view.round!.id+'/report.md',{headers})).text();assert.match(report,/P021-20/);assert.match(report,/元件数：40；不良数：8/);
  await change('sample',{sample:'pass',replaceId:board.id});await change('analyze',{},202);await ready();
  assert.equal(view.round!.photos.length,21);assert.equal(view.summary!.total,21);assert.equal(view.summary!.fail,4,'替换20件单图后不重复统计旧元件');
  await change('sample',{sample:'invalid'},400);
});

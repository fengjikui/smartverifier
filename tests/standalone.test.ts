import test from 'node:test';
import { seedAnalysis, fakeReferenceAnalysis } from './reference-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { InspectionService, person } from '../server/service.ts';
import { startServer } from '../server/index.ts';
import type { TaskView } from '../shared/types.ts';

const root=path.resolve('.');
function register(service:InspectionService,supplier='供应商甲',material='000007') {
  service.registry.addAsset({id:'11111111-1111-1111-1111-111111111111.png',filename:'测试正品.png',width:800,height:600,bytes:100,sha256:'a'.repeat(64),thumbnail:'/api/v1/inspections/marking/reference-assets/11111111-1111-1111-1111-111111111111-thumb.jpg'});
  seedAnalysis(service.registry,'11111111-1111-1111-1111-111111111111.png');
  return service.registry.save({material,supplier,modelNumber:supplier==='供应商乙'?'SV359':'SV358',name:'测试元件',description:'',lines:['SV358','A26','0147'],assetId:'11111111-1111-1111-1111-111111111111.png',status:'active'},person);
}
async function waitFor(service:InspectionService,id:string,status:string){for(let i=0;i<200;i++){const v=service.view(id);if(v.round?.status===status)return v;await delay(5);}throw Error('等待状态超时 '+status);}

test('正品选择与模拟MES：两供应商、空说明、草稿排除、查询分页及选择后自动关联',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-standalone-')),service=new InspectionService(directory,root,1);
  t.after(async()=>{service.closing=true;await delay(20);service.store.close();await rm(directory,{recursive:true,force:true});});
  const first=register(service),second=register(service,'供应商乙');
  service.registry.save({material:'DRAFT',modelNumber:'SV358',supplier:'S',name:'',description:'',lines:[],assetId:'',status:'draft'},person);
  assert.equal(service.registry.catalog('000007').total,2);assert.deepEqual(service.registry.catalog('000007').suppliers,['供应商乙','供应商甲'].sort());
  assert.equal(service.registry.catalog('000007','供应商甲').items[0].description,'');assert.equal(service.registry.catalog('DRAFT').total,0);
  const stored=service.store.tasks().length,selection=service.taskPage('供应商乙');assert.equal(selection.total,1);assert.equal(selection.items[0].origin,'demo-mes');assert.equal(selection.items[0].standard!.id,second.id);
  assert.equal(service.store.tasks().length,stored,'浏览标准或模拟任务不能批量生成数据库任务');
  const opened=service.open(selection.items[0].id);assert.equal(opened.round!.standard.id,second.id);assert.equal(service.open(opened.task.id).round!.id,opened.round!.id);
  assert.equal(service.taskPage('供应商乙').total,1,'选择过的模拟任务不能重复出现在列表');
  service.registry.save({material:first.material,modelNumber:first.modelNumber,supplier:first.supplier,name:'更新',description:'说明更新',lines:first.lines,assetId:first.assetId,status:'active'},person,first.id,1);
  assert.equal(service.registry.catalog('000007','供应商甲').items[0].version,2);
  service.store.transaction(()=>{for(let i=0;i<60;i++)service.registry.saveWithinTransaction({material:'PAGED-'+i,modelNumber:'SV358',supplier:'供应商',name:'',description:'',lines:[],assetId:first.assetId,status:'active'},person);});
  assert.equal(service.taskPage('PAGED-',3).items.length,10);assert.equal(service.taskPage('PAGED-',3).total,60);
  assert.equal(service.store.tasks().length,stored+1,'未选择的模拟任务保持虚拟，不逐条落库');
});

test('自主检测：独立保存、增量、质量阻断、人工改判、完成幂等、历史快照与禁止MES回填',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-standalone-flow-')),service=new InspectionService(directory,root,1);
  t.after(async()=>{service.closing=true;await delay(20);service.store.close();await rm(directory,{recursive:true,force:true});});
  const standard=register(service),originalTasks=service.store.tasks();let view=service.startStandalone(standard.id,1,'request-1',person);
  assert.equal(view.task.origin,'standalone');assert.equal(view.task.effectiveRoundId,null);assert.deepEqual(service.store.tasks(),originalTasks,'自主检测不能冒充MES任务');
  assert.equal(service.startStandalone(standard.id,1,'request-1',person).task.id,view.task.id,'开始请求丢失后重试幂等');
  assert.throws(()=>service.submit(view.round!.id,view.round!.revision,person),/不能回填/);assert.throws(()=>service.complete(view.round!.id,view.round!.revision,person),/明确结论/);
  view=await service.addSample(view.round!.id,view.round!.revision,'quality',undefined,person);service.analyze(view.round!.id,view.round!.revision);view=await waitFor(service,view.task.id,'draft');
  assert.equal(view.summary!.qualityPhotos,1);assert.throws(()=>service.complete(view.round!.id,view.round!.revision,person),/明确结论/);
  view=await service.addSample(view.round!.id,view.round!.revision,'four',view.round!.photos[0].id,person);service.analyze(view.round!.id,view.round!.revision);view=await waitFor(service,view.task.id,'ready');assert.equal(view.summary!.total,4);assert.equal(view.summary!.fail,1);
  const previous=structuredClone(view.round!.photos[0]);view=await service.addSample(view.round!.id,view.round!.revision,'pass',undefined,person);assert.throws(()=>service.complete(view.round!.id,view.round!.revision,person),/明确结论/);
  service.analyze(view.round!.id,view.round!.revision);view=await waitFor(service,view.task.id,'ready');assert.equal(view.summary!.total,5);assert.deepEqual(view.round!.photos[0],previous);
  const bad=view.round!.photos[0].components.find(c=>c.ai?.verdict==='FAIL')!;view=service.review(view.round!.id,view.round!.revision,bad.id,'PASS','人工已核对实物',person);assert.equal(view.summary!.fail,0);assert.equal(view.round!.photos[0].components.find(c=>c.id===bad.id)!.ai!.verdict,'FAIL');
  const stale=view.round!.revision;view=service.complete(view.round!.id,stale,person);assert.equal(view.round!.status,'completed');assert.equal(view.round!.completedBy!.id,person.id);assert.equal(view.round!.transfer,null);assert.equal(view.effective,null);assert.equal(view.summary!.verdict,'PASS');assert.equal(view.summary!.canSubmit,false);
  assert.equal(service.complete(view.round!.id,stale,person).round!.revision,view.round!.revision);assert.throws(()=>service.review(view.round!.id,view.round!.revision,bad.id,'FAIL','修改',person),/已经提交|当前轮次/);
  assert.throws(()=>service.submit(view.round!.id,view.round!.revision,person),/不能回填/);assert.equal(service.store.db.prepare('SELECT COUNT(*) n FROM receipts').get()!.n,0);
  assert.match(service.report(view.round!),/本次未关联 MES 任务/);assert.match(service.report(view.round!),/自主检测记录/);assert.match(service.report(view.round!),new RegExp('操作人：'+person.name+' '+person.id));
  service.registry.save({material:standard.material,modelNumber:standard.modelNumber,supplier:standard.supplier,name:standard.name,description:'新的检测说明',lines:standard.lines,assetId:standard.assetId,status:'active'},person,standard.id,1);
  const old=structuredClone(view.round!);assert.equal(service.view(view.task.id).round!.standard.version,1);view=service.newRound(view.task.id,false);assert.equal(view.round!.standard.version,2);assert.deepEqual(service.store.round(old.id),old);
  assert.throws(()=>service.startStandalone(standard.id,1,'stale',person),/更新/);assert.equal(service.standaloneRecent(person).length,1);assert.equal(service.standaloneRecent({id:'OTHER',name:'其他人'}).length,0);
});

test('HTTP：正品查询、供应商选择、自主检测归属、任务写入封闭及完成/回填边界',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-standalone-http-')),{server,service,admin}=startServer({state:directory,port:0,host:'127.0.0.1',delay:1,referenceAnalyzer:fakeReferenceAnalysis});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  t.after(async()=>{service.closing=true;admin.files.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await delay(30);service.store.close();await rm(directory,{recursive:true,force:true});});
  const standard=register(service);register(service,'供应商乙');
  const login=await fetch(base+'/api/v1/inspections/marking/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  async function call(url:string,data?:unknown,status=200,selectedCookie=cookie){const r=await fetch(base+'/api/v1/inspections/marking'+url,{method:data===undefined?'GET':'POST',headers:{Cookie:selectedCookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
  assert.equal((await call('/standards?material=000007')).total,2);assert.equal((await call('/standards?material=000007&supplier='+encodeURIComponent('供应商甲'))).items[0].id,standard.id);
  const view:TaskView=await call('/checks',{standardId:standard.id,version:1,clientId:'api-1'},201);
  assert.equal((await call('/checks')).items.length,1);assert.ok(!(await call('/tasks')).items.some((item:{id:string})=>item.id===view.task.id));
  await call('/rounds/'+view.round!.id+'/submit',{revision:view.round!.revision},409);await call('/rounds/'+view.round!.id+'/complete',{revision:view.round!.revision},409);
  service.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('other-person',JSON.stringify({id:'OTHER',name:'其他人'}),Date.now()+60000);
  assert.equal((await call('/checks',undefined,200,'sv_next_session=other-person')).items.length,0);
  await call('/tasks/'+view.task.id,undefined,404,'sv_next_session=other-person');await call('/rounds/'+view.round!.id+'/report.md',undefined,404,'sv_next_session=other-person');
  const started=await call('/tasks/'+(await call('/tasks?q=000007')).items[0].id+'/open',{});assert.equal(started.round.standard.material,'000007');assert.equal(started.task.origin,'demo-mes');
  assert.equal(service.store.db.prepare('SELECT COUNT(*) n FROM receipts').get()!.n,0);
});

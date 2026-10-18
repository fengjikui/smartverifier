import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { startServer } from '../server/index.ts';
import { InspectionService, person } from '../server/service.ts';
import { LocalVisionPipeline } from '../server/vision/local-pipeline.ts';
import type { ReferenceRecord, ImportJob } from '../shared/admin.ts';
import type { Task } from '../shared/types.ts';
const root=path.resolve('.');
const input={material:'00123',supplier:'测试供应商',name:'测试器件',description:'允许批次码变化。',lines:[],assetId:'',status:'active' as const};

// 模拟 MES 已同步的数据，不通过应用提供手工维护入口。
function seedMesTask(service:InspectionService,fields:{number:string;material:string;supplier:string}):Task {
  const task:Task={...fields,id:'MESTEST001',origin:'mes',standard:null,roundId:null,effectiveRoundId:null};
  service.store.saveTask(task);return task;
}

test('标准库：版本冲突、重复、任务自动绑定、软删除与历史快照保护，15000条分页查询',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-registry-')),service=new InspectionService(directory,root),r=service.registry;
  t.after(async()=>{service.store.close();await rm(directory,{recursive:true,force:true});});
  const asset={id:'11111111-1111-1111-1111-111111111111.png',filename:'正品.png',width:800,height:600,bytes:100,sha256:'a'.repeat(64),thumbnail:'/api/reference-assets/11111111-1111-1111-1111-111111111111-thumb.jpg'};r.addAsset(asset);
  assert.throws(()=>r.save(input,person),/图片/);
  let standard=r.save({...input,assetId:asset.id},person);assert.equal(standard.material,'00123');
  assert.throws(()=>r.save({...input,assetId:asset.id},person),/已存在/);
  const task=seedMesTask(service,{number:'MES-试验单-001',material:input.material,supplier:input.supplier});assert.equal(service.task(task.id).standard!.id,standard.id);
  const opened=service.open(task.id),snapshot=structuredClone(opened.round!.standard);
  standard=r.save({...input,assetId:asset.id,description:'更新后的说明'},person,standard.id,1);
  assert.throws(()=>r.save({...input,assetId:asset.id},person,standard.id,1),/更新/);
  assert.equal(service.task(task.id).standard!.version,2);assert.deepEqual(service.view(task.id).round!.standard,snapshot);
  const pipeline=new LocalVisionPipeline(root,directory);assert.equal(pipeline.reference(opened.round!),path.join(directory,'files',asset.id));
  standard=r.trash(standard.id,2,false,person);assert.equal(service.task(task.id).standard,null);assert.deepEqual(service.view(task.id).round!.standard,snapshot);
  const replacement=r.save({...input,assetId:asset.id},person);assert.throws(()=>r.trash(standard.id,3,true,person),/重复/);r.trash(replacement.id,1,false,person);standard=r.trash(standard.id,3,true,person);assert.equal(standard.version,4);
  assert.equal(r.detail(standard.id).events.length,4);assert.ok(r.detail(standard.id).tasks.some(item=>item.id===task.id));
  assert.equal(r.page('%').total,0,'LIKE通配符应按文字搜索');
  const started=performance.now();service.store.transaction(()=>{for(let i=0;i<15000;i++)r.saveWithinTransaction({...input,material:'PERF-'+String(i).padStart(5,'0'),assetId:asset.id},person);});
  const insertMs=performance.now()-started,queryAt=performance.now(),result=r.page('PERF-149','active',1,25),queryMs=performance.now()-queryAt;
  assert.equal(result.total,100);assert.equal(result.items.length,25);assert.equal(r.page('PERF-','active',600,25).items.length,25);
  assert.ok(queryMs<2000,`15000条查询耗时 ${queryMs}ms`);t.diagnostic(JSON.stringify({records:15000,insertMs:Math.round(insertMs),queryMs:Math.round(queryMs),pageSize:25}));
});

test('管理HTTP：独立权限、原图校验、Excel与JSON ZIP预检、重复跳过、错误阻断、幂等导入、关联检验',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-admin-http-')),{server,service,admin}=startServer({state:directory,port:0,host:'127.0.0.1',delay:1});await once(server,'listening');const addr=server.address();assert.ok(addr&&typeof addr!=='string');const base='http://127.0.0.1:'+addr.port;
  t.after(async()=>{admin.files.close();service.closing=true;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await delay(30);service.store.close();await rm(directory,{recursive:true,force:true});});
  let cookie='';async function call(route:string,data?:unknown,status=200,method?:string){const res=await fetch(base+'/api'+route,{method:method??(data===undefined?'GET':'POST'),headers:{...(cookie?{Cookie:cookie}:{}),...(data===undefined||data instanceof FormData?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:data instanceof FormData?data:JSON.stringify(data)});const v=await res.json();assert.equal(res.status,status,JSON.stringify(v));return v;}
  await call('/admin/references',undefined,401);await call('/admin/session',{id:'admin',code:'wrong'},401);
  const login=await fetch(base+'/api/admin/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'admin',code:'admin123'})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];assert.equal((await call('/admin/session')).person.id,'ADMIN-TRIAL');
  const inspector=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),inspectionCookie=inspector.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(base+'/api/admin/references',{headers:{Cookie:inspectionCookie}})).status,401,'检验员会话不能成为管理员');
  const bytes=await readFile('fixtures/inspection/green-mat-v1/reference-crop.png'),f=new FormData();f.set('image',new File([bytes],'正品.png'));const asset=await call('/admin/assets',f,201);assert.ok(asset.width>0);
  const raw=await fetch(base+'/api/reference-assets/'+asset.id,{headers:{Cookie:cookie}});assert.deepEqual(Buffer.from(await raw.arrayBuffer()),bytes,'保存原始字节');
  assert.equal((await fetch(base+asset.thumbnail,{headers:{Cookie:cookie}})).status,200);assert.equal((await fetch(base+'/api/reference-assets/'+asset.id)).status,401);
  const invalid=new FormData();invalid.set('image',new File([new Uint8Array([1,2,3])],'伪装.png'));await call('/admin/assets',invalid,400);
  let standard:ReferenceRecord=await call('/admin/references',{...input,assetId:asset.id},201);await call('/admin/references',{...input,assetId:asset.id},409);
  standard=await call('/admin/references/'+standard.id,{...input,assetId:asset.id,version:1,description:'更新'},200,'PUT');assert.equal(standard.version,2);
  const created=seedMesTask(service,{number:'MES-TEST-001',material:input.material,supplier:input.supplier});
  const tasksBefore=service.store.tasks();
  for(const [route,method] of [['/admin/tasks','POST'],['/admin/tasks/'+created.id,'POST'],['/admin/tasks/'+created.id,'PUT'],['/admin/tasks/'+created.id,'PATCH'],['/admin/tasks/'+created.id,'DELETE'],['/admin/tasks/T00000000000000000000000000000000','DELETE']])assert.match((await call(route,{number:'不得修改',material:'OTHER',supplier:'OTHER'},405,method)).message,/MES/);
  assert.deepEqual(service.store.tasks(),tasksBefore,'管理接口不能增删改 MES 任务');
  assert.ok((await call('/admin/tasks')).items.some((task:Task)=>task.id===created.id&&task.standard?.id===standard.id));
  assert.equal((await fetch(base+'/api/tasks/'+created.id+'/open',{method:'POST',headers:{Cookie:inspectionCookie,'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())).round.standard.id,standard.id);
  for(const kind of ['xlsx','json','zip','help'])assert.equal((await fetch(base+'/api/admin/templates/'+kind,{headers:{Cookie:cookie}})).status,200);
  async function poll(id:string){for(let i=0;i<100;i++){const j:ImportJob=await call('/admin/imports/'+id);if(j.status!=='validating')return j;await delay(100);}throw Error('预检超时');}
  const pack=new FormData();pack.append('files',new File([await readFile('next/templates/reference-import-v1/JSON标准包示例.zip')],'示例.zip'));
  let job:ImportJob=await poll((await call('/admin/imports',pack,202)).id);assert.equal(job.status,'preview',job.message);assert.equal(job.counts.ready,2);
  job=await call('/admin/imports/'+job.id+'/commit',{});assert.equal(job.receipt!.created,2);assert.deepEqual((await call('/admin/imports/'+job.id+'/commit',{})).receipt,job.receipt);
  const again=new FormData();again.append('files',new File([await readFile('next/templates/reference-import-v1/JSON标准包示例.zip')],'示例.zip'));assert.equal((await poll((await call('/admin/imports',again,202)).id)).counts.skip,2);
  const missing=new FormData();missing.append('files',new File([JSON.stringify({schemaVersion:'1.0',records:[{materialCode:'NEW',supplierName:'S',imagePath:'lost.png'}]})],'standards.json'));
  const bad=await poll((await call('/admin/imports',missing,202)).id);assert.equal(bad.counts.error,1);await call('/admin/imports/'+bad.id+'/commit',{},409);
  // 真正生成工作簿，验证前导零与公式不会被悄悄改写。
  const generated=path.join(directory,'excel.xlsx');const python=process.env.SV_VISION_PYTHON??path.join(root,'agent-tools/image-focus/.venv/bin/python');
  const result=spawnSync(python,['-c',"import openpyxl,sys;w=openpyxl.Workbook();s=w.active;s.title='标准清单';s.append(['物料编号','供应商名称','正品图片路径','检测说明']);s.append(['000007','Excel供应商','正品.png','允许日期变化']);s.append([123,'Excel供应商','正品.png','不允许数字类型编号']);s.append(['FORMULA','Excel供应商','正品.png','=1+1']);w.save(sys.argv[1])",generated]);assert.equal(result.status,0);
  const excel=new FormData();excel.append('files',new File([await readFile(generated)],'标准.xlsx'));excel.append('files',new File([bytes],'正品.png'));
  const ej=await poll((await call('/admin/imports',excel,202)).id);assert.equal(ej.rows[0].material,'000007');assert.equal(ej.counts.ready,1);assert.equal(ej.counts.error,2);assert.match(ej.rows[1].message,/文本/);assert.match(ej.rows[2].message,/公式/);
  assert.equal(spawnSync(python,['-c',"import openpyxl,sys;w=openpyxl.load_workbook(sys.argv[1]);w.active.delete_rows(3,2);w.save(sys.argv[1])",generated]).status,0);
  const corrected=new FormData();corrected.append('files',new File([await readFile(generated)],'已修正.xlsx'));corrected.append('files',new File([bytes],'正品.png'));
  const clean=await poll((await call('/admin/imports',corrected,202)).id);assert.equal(clean.counts.error,0);assert.equal((await call('/admin/imports/'+clean.id+'/commit',{})).receipt.created,1);assert.equal((await call('/admin/references?q=000007')).items[0].material,'000007');
  const traversal=path.join(directory,'unsafe.zip');assert.equal(spawnSync(python,['-c',"import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('../escape.png',b'x');z.close()",traversal]).status,0);
  const malicious=new FormData();malicious.append('files',new File([await readFile(traversal)],'unsafe.zip'));const unsafe=await poll((await call('/admin/imports',malicious,202)).id);assert.equal(unsafe.status,'failed');assert.match(unsafe.message,/不安全/);
  await call('/admin/session',{},200,'DELETE');await call('/admin/references',undefined,401);
});

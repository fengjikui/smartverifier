import test from 'node:test';
import { seedAnalysis, fakeReferenceAnalysis } from './reference-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InspectionService, person } from '../server/service.ts';
import { prepareImport } from '../server/admin/imports.ts';
import { referenceInput, Registry } from '../server/admin/registry.ts';
import { AdminAuth } from '../server/admin/auth.ts';
import { referenceScope } from '../server/vision/reference-scope.ts';
import { imagePoint, rotatedSize, rotatePoint, zoomAt } from '../shared/image-editor.ts';
import type { ImportJob, ImportRow } from '../shared/admin.ts';

const base={material:'00001',modelNumber:'SV358',supplier:'',name:'',description:'',lines:[],assetId:'11111111-1111-1111-1111-111111111111.png',status:'active' as const};
async function setup(t:any){const directory=await mkdtemp(path.join(tmpdir(),'sv-reference-workflow-')),service=new InspectionService(directory,path.resolve('.'));t.after(async()=>{service.store.close();await rm(directory,{recursive:true,force:true});});service.registry.addAsset({id:base.assetId,filename:'reference.png',width:800,height:600,bytes:100,sha256:'a'.repeat(64),thumbnail:''});seedAnalysis(service.registry,base.assetId);return service;}
const row=(n:number,values:Partial<ImportRow>={}):ImportRow=>({row:n,...base,imagePath:`folder${n}/00001 SV358.png`,status:'ready',message:'',...values});
const job=(rows:ImportRow[]):ImportJob=>({id:crypto.randomUUID(),status:'validating',filename:'测试.zip',rows,message:'',counts:{ready:0,skip:0,error:0},createdAt:new Date().toISOString()});

test('新匹配键：供应商可空/可变；型号必填，同物料不同型号独立，不回退供应商匹配',async t=>{
 const service=await setup(t),r=service.registry,a=r.save(base,person);assert.throws(()=>r.save({...base,modelNumber:''},person));assert.throws(()=>r.save({...base,supplier:'另一家供应商'},person),/已存在/);
 const b=r.save({...base,modelNumber:'SV359'},person);assert.equal(r.match(base.material,'SV358')!.id,a.id);assert.equal(r.match(base.material,'SV359')!.id,b.id);assert.equal(r.match(base.material,'另一家供应商'),null);
 const edited=r.save({...base,supplier:'供应商更新'},person,a.id,1);assert.equal(edited.id,a.id);assert.equal(r.match(base.material,'SV358')!.supplier,'供应商更新');
});
test('批量：同批候选无默认赢家，明确采用一张；好条目先保存，暂存跨读取保留',async t=>{
 const r=(await setup(t)).registry,j=prepareImport(r,job([row(1),row(2,{supplier:'其他供应商'}),row(3,{material:'00002'}),row(4,{material:'',status:'error',message:'文件名有误'})]));r.saveJob(j,person.id);
 assert.deepEqual(j.rows.map(r=>r.decision),['defer','defer','include','defer']);assert.equal(j.counts.ready,1);
 assert.throws(()=>r.decideJob(j.id,person,1,[1,2],'include'),/每组只能/);
 let v=r.decideJob(j.id,person,1,[2],'include');assert.equal(v.rows[0].decision,'defer');assert.equal(v.rows[1].decision,'include');
 v=r.commitJob(j.id,person,v.version);assert.equal(v.receipt!.created,2);assert.equal(r.page().total,2);assert.equal(v.rows[0].savedId,undefined);assert.ok(v.rows[1].savedId);assert.equal(v.counts.error,1);assert.equal(r.jobs(person.id).length,1);
 r.commitJob(j.id,person,v.version);assert.equal(r.page().total,2,'再次保存不重复创建');assert.equal(r.job(j.id,person.id).rows[0].imagePath,'folder1/00001 SV358.png');
 assert.throws(()=>r.job(j.id,'OTHER'),/属于其他/);
});
test('覆盖替换全量资料并留版本；过期预览只能暂存，不能覆盖他人新修改',async t=>{
 const r=(await setup(t)).registry;seedAnalysis(r,base.assetId,[{id:'i',kind:'ignore',x:.1,y:.1,width:.1,height:.1,label:'old'}]);const original=r.save({...base,description:'旧说明',lines:['旧文字'],regions:[{id:'i',kind:'ignore',x:.1,y:.1,width:.1,height:.1,label:'old'}]},person);
 let j=prepareImport(r,job([row(1,{supplier:'新供应商'})]));r.saveJob(j,person.id);assert.equal(j.rows[0].decision,'defer');j=r.decideJob(j.id,person,1,[1],'include');j=r.commitJob(j.id,person,j.version);
 const updated=r.get(original.id);assert.equal(updated.version,2);assert.equal(updated.description,'');assert.deepEqual(updated.lines,[]);assert.deepEqual(updated.regions,[]);assert.equal(updated.supplier,'新供应商');assert.equal(j.receipt!.updated,1);assert.equal(r.detail(original.id).events.length,2);
 let stale=prepareImport(r,job([row(1)]));r.saveJob(stale,person.id);stale=r.decideJob(stale.id,person,1,[1],'include');r.save({...base,description:'其他人新编辑'},person,original.id,2);stale=r.commitJob(stale.id,person,stale.version);assert.equal(stale.rows[0].decision,'defer');assert.match(stale.rows[0].message,/发生变化/);assert.equal(r.get(original.id).description,'其他人新编辑');
});
test('旧数据新键迁移：重复或无型号停用保留；管理员账号、版本和图片不删除',async t=>{
 const service=await setup(t),r=service.registry,a=r.save({...base,supplier:'甲'},person),b=r.save({...base,material:'00002',supplier:'乙'},person);
 const accounts=new AdminAuth(service.store,{localOnly:true,users:[{id:'migration-admin',name:'迁移测试管理员',salt:'test-only-salt',hash:'f'.repeat(64),role:'standard_admin'}]}).accounts;const accountBefore=accounts.get('migration-admin'),taskBefore=service.store.tasks();
 service.store.db.exec('DROP INDEX reference_material_model; DROP INDEX reference_lookup; ALTER TABLE reference_records DROP COLUMN model_number;');
 const copy={...b,material:a.material,modelNumber:a.modelNumber};service.store.db.prepare('UPDATE reference_records SET material=?,data=? WHERE id=?').run(a.material,JSON.stringify(copy),b.id);
 const migrated=new Registry(service.store);assert.equal(migrated.get(a.id).status,'draft');assert.equal(migrated.get(b.id).status,'draft');assert.ok(migrated.asset(base.assetId));assert.equal(service.store.db.prepare('SELECT count(*) n FROM reference_versions').get()!.n,2);assert.equal(migrated.match(a.material,a.modelNumber!),null);assert.deepEqual(accounts.get('migration-admin'),accountBefore);assert.deepEqual(service.store.tasks(),taskBefore);
});
test('编辑坐标：以指针缩放不漂移；旋转保持视窗中心；区域互斥且提示只作用对应位置',()=>{
 const original={x:57,y:-23,scale:.3},anchor={x:100,y:-80},size={width:2000,height:1500};const before=imagePoint(anchor,original,size),after=imagePoint(anchor,zoomAt(original,anchor,.9),size);assert.ok(Math.abs(before.x-after.x)<1e-12&&Math.abs(before.y-after.y)<1e-12);
 assert.deepEqual(rotatePoint({x:100,y:0},90),{x:100*Math.cos(Math.PI/2),y:100});const bounds=rotatedSize(800,600,90);assert.ok(Math.abs(bounds.width-600)<1e-8&&Math.abs(bounds.height-800)<1e-8);
 const regions=[{id:'a',kind:'ignore' as const,x:.1,y:.1,width:.2,height:.2,label:'编号95678可变'},{id:'b',kind:'focus' as const,x:.5,y:.5,width:.2,height:.2,label:'型号'}];assert.ok(referenceInput.safeParse({...base,regions}).success);assert.equal(referenceInput.safeParse({...base,regions:[regions[0],{...regions[1],x:.15,y:.15}]}).success,false);assert.match(referenceScope({description:'',regions}),/不能一并忽略/);assert.match(referenceScope({description:'',regions}),/仅检查绿色/);
});

test('同批候选保存后可明确改用另一张，仍覆盖同一标准且保留原版本',async t=>{
 const r=(await setup(t)).registry;let j=prepareImport(r,job([row(1),row(2)]));r.saveJob(j,person.id);j=r.decideJob(j.id,person,1,[1],'include');j=r.commitJob(j.id,person,j.version);const id=j.rows[0].savedId!;assert.equal(j.rows[1].duplicateId,id);j=r.decideJob(j.id,person,j.version!,[2],'include');j=r.commitJob(j.id,person,j.version);assert.equal(j.receipt!.updated,1);assert.equal(r.page().total,1);assert.equal(r.get(id).version,2);assert.equal(j.status,'committed');
});
test('异步分析不覆盖人工编辑文字；自动文字行仍随完成结果填充，草稿可补齐后启用',async t=>{
 const r=(await setup(t)).registry,analysisId=seedAnalysis(r,base.assetId),analysis=r.analysis(analysisId)!;
 const j=job([row(1,{analysisId,manualContent:true,description:'人工说明',lines:['人工文字']}),row(2,{material:'00002',analysisId,manualContent:false})]);j.status='preview';j.version=1;r.saveJob(j,person.id);r.applyAnalysisToImports(analysis);const updated=r.job(j.id,person.id);assert.deepEqual(updated.rows[0].lines,['人工文字']);assert.equal(updated.rows[0].description,'人工说明');assert.deepEqual(updated.rows[1].lines,analysis.result!.lines);assert.equal(updated.version,2);
 const draft=r.save({...base,material:'',modelNumber:'',status:'draft'},person);assert.equal(draft.status,'draft');const active=r.save({...base,material:'00003',analysisId},person,draft.id,draft.version);assert.equal(active.status,'active');assert.deepEqual(r.catalog('SV358').suppliers,[]);assert.equal(r.catalog('SV358').total,1);
});

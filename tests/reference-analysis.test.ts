import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { InspectionService, person } from '../server/service.ts';
import { AdminFiles } from '../server/admin/files.ts';
import { ReferenceAnalyses,analysisKey } from '../server/admin/analysis.ts';
import { inModelSlot } from '../server/vision/model-slot.ts';
import { analyzeReference } from '../server/vision/reference-analysis.ts';
import { storedRar } from './rar-fixture.ts';
import { fakeReferenceAnalysis } from './reference-fixture.ts';
import { regionInstructions,REFERENCE_SCOPE_VERSION } from '../shared/reference-analysis.ts';
import { analysisAutofill,analysisText } from '../shared/reference-autofill.ts';
import type { ReferenceAsset,ReferenceRegion } from '../shared/admin.ts';
const asset:ReferenceAsset={id:'11111111-1111-1111-1111-111111111111.png',filename:'0001 SV358.png',width:800,height:600,bytes:100,sha256:'a'.repeat(64),thumbnail:''};
const input={material:'0001',modelNumber:'SV358',supplier:'',name:'',description:'',lines:[],assetId:asset.id,status:'active' as const};
async function setup(t:any){const dir=await mkdtemp(path.join(tmpdir(),'sv-analysis-')),service=new InspectionService(dir,path.resolve('.'));t.after(async()=>{service.store.close();await rm(dir,{recursive:true,force:true});});service.registry.addAsset(asset);return service;}
async function settled(q:ReferenceAnalyses,id:string){for(let i=0;i<100;i++){const a=q.registry.analysis(id)!;if(['completed','failed'].includes(a.state))return a;await delay(5);}throw Error('分析等待超时');}

test('启用门槛绑定图片＋区域；排队不能启用，完成后可启用，换图或改区域拒用旧结果',async t=>{
 const r=(await setup(t)).registry;let finish!:(v:ReturnType<typeof fakeReferenceAnalysis>)=>void;const q=new ReferenceAnalyses(r,()=>new Promise(resolve=>finish=resolve),'TEST-ONLY');t.after(()=>q.close());
 const a=q.start(asset.id);assert.throws(()=>r.save(input,person),/分析尚未完成/);assert.equal(r.save({...input,status:'draft'},person).status,'draft');await delay(1);finish(fakeReferenceAnalysis());await settled(q,a.id);
 const draft=r.page().items[0],saved=r.save({...input,analysisId:a.id},person,draft.id,1);assert.equal(saved.status,'active');assert.ok(saved.analysis?.result);
 r.addAsset({...asset,id:'22222222-2222-2222-2222-222222222222.png'});assert.throws(()=>r.save({...input,material:'0002',assetId:'22222222-2222-2222-2222-222222222222.png',analysisId:a.id},person),/分析尚未完成/);
 assert.throws(()=>r.save({...input,material:'0003',regions:[{id:'r1',kind:'ignore',x:.1,y:.1,width:.2,height:.2,label:''}],analysisId:a.id},person),/分析尚未完成/);
});
test('质量问题与字形歧义分开，强制采用仍须已完成分析，并保留人员原因与筛选记录',async t=>{
 const r=(await setup(t)).registry,q=new ReferenceAnalyses(r,()=>({...fakeReferenceAnalysis(),quality:'poor',qualityReason:'关键字反光',ambiguities:[{text:'S/5',reason:'此字体实际难辨'}]}),'TEST-ONLY');t.after(()=>q.close());const a=await settled(q,q.start(asset.id).id);
 assert.throws(()=>r.save({...input,analysisId:a.id},person),/确认分析/);const record=r.save({...input,analysisId:a.id,reviewReason:'已核对实物，知悉问题后强制采用'},person);assert.equal(record.manualApproval!.kind,'override');assert.equal(record.manualApproval!.actor.id,person.id);assert.equal(r.page('','quality').total,1);assert.equal(r.page('','ambiguity').total,1);assert.equal(r.page('','override').total,1);
 const fresh=q.start(asset.id,[],true);assert.notEqual(fresh.id,a.id);assert.throws(()=>r.save({...input,material:'0002',analysisId:fresh.id,reviewReason:'强制采用'},person),/分析尚未完成/);await settled(q,fresh.id);
});
test('区域说明具体引用可靠文字；读不出保留空间定位，不编字；遗漏编号拒绝',async()=>{
 const regions:ReferenceRegion[]=[{id:'ignore1',kind:'ignore',x:.2,y:.6,width:.5,height:.1,label:'可变编号'}],result={...fakeReferenceAnalysis(),regionReadings:[{id:'ignore1',text:'95678',readable:true}]};
 const pipeline:any={filename:()=>'/fixture.png',timeoutSeconds:5,worker:async(req:any)=>{assert.equal(req.responseSchema.properties.regionReadings.minItems,regions.length);assert.equal(req.responseSchema.properties.regionReadings.maxItems,regions.length);assert.deepEqual(req.responseSchema.properties.regionReadings.items.properties.id.enum,regions.map(r=>r.id));return ({response:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}});}};
 let value=await analyzeReference(pipeline,asset,regions);assert.equal(value.regionReadings[0].text,'95678');assert.match(regionInstructions(regions,{result:value} as any),/95678/);
 result.regionReadings[0].readable=false;value=await analyzeReference(pipeline,asset,regions);assert.equal(value.regionReadings[0].text,null);assert.doesNotMatch(regionInstructions(regions,{result:value} as any),/95678/);
 result.regionReadings=[];await assert.rejects(()=>analyzeReference(pipeline,asset,regions),/遗漏/);
});
test('区域转写提示按位置筛选；自动填写只采用lines，忽略区读文只用于说明，保留人工改字',async()=>{
 const regions:ReferenceRegion[]=[{id:'ignore',kind:'ignore',x:.1,y:.6,width:.5,height:.1,label:'可变编号'},{id:'focus',kind:'focus',x:.1,y:.1,width:.5,height:.2,label:'型号'}];
 const result={...fakeReferenceAnalysis(),lines:['SV358'],regionReadings:[{id:'ignore',text:'95678',readable:true},{id:'focus',text:'SV358',readable:true}]};
 const pipeline:any={filename:()=>'/fixture.png',timeoutSeconds:5,worker:async(req:any)=>{
  assert.match(req.analysisPrompt,/lines用于自动填写“需比对的正品丝印文字”/);
  assert.match(req.analysisPrompt,/只纳入所有绿色重点区内/);assert.match(req.analysisPrompt,/黄色忽略区内的文字都不能放入lines/);
  assert.match(req.analysisPrompt,/不能按字符串全局删除/);assert.match(req.analysisPrompt,/lines返回空数组/);
  assert.match(req.responseSchema.properties.lines.description,/按位置筛选/);
  return {response:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}};
 }};
 const value=await analyzeReference(pipeline,asset,regions),next=analysisText({result:value} as any,regions);
 assert.deepEqual(next.lines,['SV358']);assert.match(next.description,/95678/);
 assert.deepEqual(analysisAutofill({lines:['SV358','95678'],description:''},next,{lines:['SV358','95678'],description:''}).lines,['SV358']);
 assert.equal(analysisAutofill({lines:['人工内容'],description:''},next,{lines:['SV358','95678'],description:''}).lines,undefined);
 // 重复文字可以属于不同位置，服务端不按忽略区转写做全局字符串删除。
 result.lines=['95678'];assert.deepEqual((await analyzeReference(pipeline,asset,regions)).lines,['95678']);
 result.lines=[];assert.deepEqual((await analyzeReference(pipeline,asset,regions)).lines,[]);
});
test('旧版带框全文缓存升级后重新分析一次，新结果可缓存；旧分析保留',async t=>{
 const r=(await setup(t)).registry,regions:ReferenceRegion[]=[{id:'ignore',kind:'ignore',x:.1,y:.6,width:.5,height:.1,label:''}];
 const old={id:crypto.randomUUID(),assetId:asset.id,key:analysisKey(asset.id,regions),regions,state:'completed',stage:'ready',message:'旧版全文分析',createdAt:new Date().toISOString(),model:'TEST-ONLY',result:fakeReferenceAnalysis()};
 r.store.db.prepare('INSERT INTO reference_analyses VALUES(?,?,?,?)').run(old.id,asset.id,old.key,JSON.stringify(old));
 let calls=0;const q=new ReferenceAnalyses(r,()=>{calls++;return {...fakeReferenceAnalysis(),lines:['SV358','A26']};},'TEST-ONLY');t.after(()=>q.close());
 const current=await settled(q,q.start(asset.id,regions).id);assert.notEqual(current.id,old.id);assert.equal(current.scopeVersion,REFERENCE_SCOPE_VERSION);
 assert.equal(q.start(asset.id,regions).id,current.id);assert.equal(calls,1);assert.deepEqual(r.analysis(old.id)!.result!.lines,['SV358','A26','0147']);
});
test('分析失败可重试，服务重启打断状态；模型槽位串行且失败后释放',async t=>{
 const r=(await setup(t)).registry,q=new ReferenceAnalyses(r,()=>{throw Error('模型不可用');});t.after(()=>q.close());const a=await settled(q,q.start(asset.id).id);assert.equal(a.state,'failed');assert.throws(()=>r.save({...input,analysisId:a.id},person),/分析尚未完成/);
 const replacement=new ReferenceAnalyses(r,()=>fakeReferenceAnalysis(),'TEST-ONLY');t.after(()=>replacement.close());assert.equal((await settled(replacement,replacement.start(asset.id).id)).state,'completed');
 let running=0,peak=0;await Promise.allSettled([1,2,3].map(n=>inModelSlot(async()=>{running++;peak=Math.max(peak,running);await delay(5);running--;if(n===2)throw Error('one failure');})));assert.equal(peak,1);assert.equal(running,0);
});

test('复用已完成的图片分析仍自动填入批量丝印，不因缓存命中丢失文字',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sv-analysis-cache-')),service=new InspectionService(dir,path.resolve('.')),q=new ReferenceAnalyses(service.registry,()=>fakeReferenceAnalysis(),'TEST-ONLY'),files=new AdminFiles(service.registry,path.resolve('.'),dir,q);t.after(async()=>{files.close();service.store.close();await rm(dir,{recursive:true,force:true});});
 const bytes=await readFile('fixtures/inspection/green-mat-v1/reference-crop.png'),asset=await files.upload(new File([bytes],'0001 SV358.png'));await settled(q,asset.analysisId!);
 const started=await files.start([new File([storedRar([{name:'0002 SV358.png',data:bytes}])],'标准.rar')],person);for(let n=0;files.busy&&n<500;n++)await delay(5);assert.equal(files.busy,false);const j=service.registry.job(started.id,person.id);assert.equal(j.status,'preview',j.message);assert.equal(j.rows[0].analysis?.state,'completed');assert.deepEqual(j.rows[0].lines,['SV358','A26','0147']);
});

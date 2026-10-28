import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { InspectionService, person } from '../server/service.ts';
import { AdminFiles } from '../server/admin/files.ts';
import { ReferenceAnalyses } from '../server/admin/analysis.ts';
import { inModelSlot } from '../server/vision/model-slot.ts';
import { analyzeReference } from '../server/vision/reference-analysis.ts';
import { storedRar } from './rar-fixture.ts';
import { fakeReferenceAnalysis } from './reference-fixture.ts';
import { regionInstructions } from '../shared/reference-analysis.ts';
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
 const pipeline:any={filename:()=>'/fixture.png',timeoutSeconds:5,worker:async()=>({response:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}})};
 let value=await analyzeReference(pipeline,asset,regions);assert.equal(value.regionReadings[0].text,'95678');assert.match(regionInstructions(regions,{result:value} as any),/95678/);
 result.regionReadings[0].readable=false;value=await analyzeReference(pipeline,asset,regions);assert.equal(value.regionReadings[0].text,null);assert.doesNotMatch(regionInstructions(regions,{result:value} as any),/95678/);
 result.regionReadings=[];await assert.rejects(()=>analyzeReference(pipeline,asset,regions),/遗漏/);
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

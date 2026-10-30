import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { InspectionService,person } from '../server/service.ts';
import { AdminFiles } from '../server/admin/files.ts';
import { ReferenceAnalyses } from '../server/admin/analysis.ts';
import { referenceInput } from '../server/admin/registry.ts';
import { analysisIssues } from '../shared/reference-analysis.ts';
import { analysisAutofill,analysisText } from '../shared/reference-autofill.ts';
import { previewTransform,regionPoints,regionsOverlap,transformRegions } from '../shared/reference-geometry.ts';
import { fakeReferenceAnalysis } from './reference-fixture.ts';
import type { ReferenceRegion } from '../shared/admin.ts';
const regions:ReferenceRegion[]=[{id:'focus',kind:'focus',x:.3,y:.2,width:.3,height:.12,label:'型号'},{id:'ignore',kind:'ignore',x:.3,y:.6,width:.3,height:.1,label:'可变编号'}];
async function settled(q:ReferenceAnalyses,id:string){for(let n=0;n<200;n++){const a=q.registry.analysis(id)!;if(['completed','failed'].includes(a.state))return a;await delay(5);}throw Error('等待超时');}

test('任意角度标记保持四边形；旋转、裁剪与逆变换对应同一位置，切掉区域拒绝且互斥不扩大',()=>{
 for(const angle of [0,90,27,-63,180]){
  const t=previewTransform(800,600,angle),out=transformRegions(regions,t),back=transformRegions(out,t,true);
  assert.equal(out.length,2);assert.equal(regionsOverlap(out[0],out[1]),false);
  for(let i=0;i<2;i++)for(let p=0;p<4;p++){assert.ok(Math.abs(regionPoints(back[i])[p].x-regionPoints(regions[i])[p].x)<1e-7);assert.ok(Math.abs(regionPoints(back[i])[p].y-regionPoints(regions[i])[p].y)<1e-7);}
  assert.ok(referenceInput.safeParse({material:'TRY',modelNumber:'X',status:'draft',regions:out}).success);
 }
 const cropped=transformRegions(regions,previewTransform(800,600,0,{x:.1,y:.1,width:.8,height:.8}));assert.ok(Math.abs(cropped[0].x-.25)<1e-9);
 assert.throws(()=>transformRegions(regions,previewTransform(800,600,0,{x:.4,y:0,width:.5,height:1})),/切掉/);
 const invalid=structuredClone(cropped);invalid[0].polygon![0].x=.99;assert.equal(referenceInput.safeParse({status:'draft',material:'TRY',regions:invalid}).success,false);
});

test('真实图片编辑不调用新VLM：沿用分析、保留读文与问题、带框启用保存；手动重分析和新区域仍调用',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sv-transform-')),s=new InspectionService(dir,path.resolve('.'));let calls=0;
 const q=new ReferenceAnalyses(s.registry,(_asset,marks)=>{calls++;return {...fakeReferenceAnalysis(),regionReadings:marks.map(r=>({id:r.id,text:r.kind==='ignore'?'0147':'SV358',readable:true}))};},'TEST-ONLY'),files=new AdminFiles(s.registry,path.resolve('.'),dir,q);
 t.after(async()=>{files.close();s.store.close();await rm(dir,{recursive:true,force:true});});
 const bytes=await readFile('fixtures/inspection/green-mat-v1/reference-crop.png'),a=await files.upload(new File([bytes],'TRY001 SV358.png'));await settled(q,a.analysisId!);assert.equal(calls,1);
 const marked=await settled(q,q.start(a.id,regions).id);assert.equal(calls,2);
 const edited=await files.edit(a.id,{angle:27,regions});assert.ok(edited.derivation);assert.equal(edited.regions.length,2);
 const inherited=await settled(q,q.start(edited.id,edited.regions).id);assert.equal(calls,2);assert.equal(inherited.inheritedFrom,marked.id);assert.deepEqual(inherited.result!.lines,['SV358','A26','0147']);assert.deepEqual(analysisIssues(inherited),analysisIssues(marked));
 const saved=s.registry.save({material:'TRY001',modelNumber:'SV358',supplier:'',name:'',description:'',lines:inherited.result!.lines,status:'active',assetId:edited.id,regions:edited.regions,analysisId:inherited.id},person);
 assert.equal(saved.regions!.length,2);assert.ok(saved.regions![0].polygon);assert.match(saved.regionDescription!,/0147/);assert.ok(s.registry.catalog('TRY001').items[0].regions?.[0].polygon);
 const text=analysisText(inherited,edited.regions);assert.match(text.description,/0147/);assert.deepEqual(analysisAutofill({lines:['人工文字'],description:'人工说明'},text),{});assert.equal(analysisAutofill({lines:[],description:''},text).description,text.description);
 const next={...text,description:'更新的区域说明'};assert.equal(analysisAutofill(text,next,text).description,'更新的区域说明');assert.deepEqual(await readFile(path.join(dir,'files',a.id)),bytes);
 await settled(q,q.start(edited.id,edited.regions,true).id);assert.equal(calls,3);
 await settled(q,q.start(edited.id,edited.regions.map(r=>({...r,label:'新规则'}))).id);assert.equal(calls,4);
 await assert.rejects(()=>files.edit(a.id,{angle:0,crop:{x:.4,y:0,width:.5,height:1},regions}),/切掉/);assert.equal(calls,4);
});

test('分析中裁剪等待原结果而不增加推理；原分析失败、缺失和低质量都不会被裁剪伪装通过',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sv-transform-wait-')),s=new InspectionService(dir,path.resolve('.'));t.after(async()=>{s.store.close();await rm(dir,{recursive:true,force:true});});
 const source={id:'11111111-1111-1111-1111-111111111111.png',filename:'a.png',width:800,height:600,bytes:100,sha256:'x',thumbnail:''},target={...source,id:'22222222-2222-2222-2222-222222222222.png'};s.registry.addAsset(source);s.registry.addAsset(target);
 let calls=0,finish!:(v:ReturnType<typeof fakeReferenceAnalysis>)=>void;const q=new ReferenceAnalyses(s.registry,()=>{calls++;return new Promise(resolve=>finish=resolve);},'TEST');t.after(()=>q.close());
 const original=q.start(source.id);await delay(1);const derived=q.transformed(source.id,target.id,[],[],previewTransform(800,600,20));finish({...fakeReferenceAnalysis(),quality:'poor',qualityReason:'实际模糊'});await settled(q,original.id);const out=await settled(q,derived.id);assert.equal(calls,1);assert.equal(out.result!.quality,'poor');assert.match(analysisIssues(out).join(),/模糊/);
 const missing=q.transformed(source.id,target.id,regions,regions,previewTransform(800,600,0));assert.equal(missing.state,'failed');assert.equal(q.start(target.id,regions).id,missing.id);assert.equal(calls,1);
});

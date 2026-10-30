import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalVisionPipeline } from '../server/vision/local-pipeline.ts';
import { parsePhotoReply,photoJsonSchema } from '../server/vision/photo-reply.ts';
import { InspectionService,person } from '../server/service.ts';
const item=(n:number,verdict:'PASS'|'FAIL'='PASS')=>({componentId:'C'+String(n).padStart(2,'0'),bbox:[.1+(n-1)*.25,.2,.2,.5],status:'decided',verdict,lines:['SV358','A26','0147'],confidence:.95,reason:'测试协议返回',features:[],differences:[]});
const reply=(items:unknown[])=>({quality:{state:'usable',reason:''},coverage:'complete',items,instructionConflicts:[]});
test('整图Schema支持未知件数；按连续ID匹配，拒绝漏号、重复、越界、空成功和截断',()=>{
 const s=photoJsonSchema();assert.equal(s.properties.items.minItems,0);assert.equal(s.properties.items.maxItems,100);
 assert.deepEqual(parsePhotoReply(JSON.stringify(reply([item(2),item(1)]))).items.map(i=>i.componentId),['C01','C02']);
 for(const r of [reply([]),reply([item(2)]),reply([item(1),item(1)]),reply([{...item(1),bbox:[.9,0,.5,.5]}]),reply([{...item(1),confidence:null}])])assert.throws(()=>parsePhotoReply(JSON.stringify(r)));
 assert.throws(()=>parsePhotoReply(JSON.stringify(reply([item(1)])).slice(0,-1)));
 const unreadable={quality:{state:'needs_recapture',reason:'VLM判断无元件'},coverage:'uncertain',items:[],instructionConflicts:[]};assert.equal(parsePhotoReply(JSON.stringify(unreadable)).items.length,0);
});

test('整图真实适配路径：绕过旧CV坏裁片、单图多件计数、VLM唯一质量来源、重判与失败保护',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sv-whole-photo-')),root=process.cwd(),pipeline=new LocalVisionPipeline(root,dir),service=new InspectionService(dir,root,1,pipeline);
 t.after(async()=>{service.closing=true;pipeline.close();while(service.worker)await delay(5);service.store.close();await rm(dir,{recursive:true,force:true});});
 let mode:'clear'|'blur'|'low'|'broken'='clear',inspections=0,decodes=0;const sent:Record<string,unknown>[]=[];
 pipeline.worker=async req=>{sent.push(req);if(req.action==='inspect_image'){decodes++;return {version:'whole-photo-v1',width:1536,height:1024};}assert.equal(req.action,'recognize_photo');inspections++;
  let value=reply([item(1),item(2,'FAIL'),item(3)]);
  if(mode==='blur')value={...value,quality:{state:'needs_recapture',reason:'VLM判断第二个元件关键字符看不清'},items:[item(1),{...item(2),status:'unreadable',verdict:null,confidence:null,lines:[],reason:'字符反光无法判读'},item(3)]} as any;
  if(mode==='low')value=reply([{...item(1),confidence:.1}]);if(mode==='broken')value=reply([item(2)]);
  return {model:'TEST-ONLY',elapsedMs:10,promptVersion:'silkscreen-whole-photo-v1',response:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}};
 };
 let view=service.open('REALVISION2');view=await service.addRealTrial(view.round!.id,view.round!.revision,person);
 // 旧CV结果即使同源hash也不能继续裁坏图片或用旧锐度挡住模型。
 const old=view.round!.photos[0];old.preparation={version:'green-contours-v1',sourceHash:old.hash,uprightUrl:old.url,annotatedUrl:old.url,sheetUrl:old.url,width:1536,height:1024,elapsedMs:1,coverage:'uncertain',issues:['旧CV锐度过低']};service.store.saveRound(view.round!);
 async function analyze(){service.analyze(view.round!.id,view.round!.revision);while(service.worker)await delay(5);view=service.view(view.task.id);}
 await analyze();assert.equal(inspections,1);assert.equal(decodes,1);assert.equal(view.summary!.total,3);assert.equal(view.summary!.fail,1);assert.equal(view.summary!.canSubmit,true);
 const photo=view.round!.photos[0];assert.equal(photo.preparation!.mode,'original');assert.equal(sent.at(-1)!.sample,pipeline.filename(photo.file));assert.ok(photo.components.every(c=>!c.crop&&c.viewMode==='original'));assert.doesNotMatch(service.report(view.round!),/裁片白板/);
 view=service.notes(view.round!.id,view.round!.revision,'允许批次码变化',person);await analyze();assert.equal(decodes,1,'改说明复用原图尺寸，不重新分离');assert.equal(view.round!.photos[0].components[0].aiHistory.length,2);
 mode='blur';view=service.notes(view.round!.id,view.round!.revision,'新说明',person);await analyze();assert.equal(view.summary!.qualityPhotos,1);assert.equal(view.summary!.completed,2);assert.equal(view.summary!.canSubmit,false);assert.match(view.round!.photos[0].message,/VLM判断/);
 mode='low';await analyze();assert.equal(view.summary!.qualityPhotos,0);assert.equal(view.summary!.pass,1);assert.equal(view.summary!.canSubmit,true,'低自评分只提示复核，不代替VLM质量结论');
 mode='broken';view=service.notes(view.round!.id,view.round!.revision,'再次检测',person);await analyze();assert.equal(view.summary!.failedPhotos,1);assert.equal(view.summary!.canSubmit,false);assert.ok(Number(service.store.db.prepare("SELECT count(*) n FROM audit WHERE action='photo.previous-results'").get()!.n)>0);
});

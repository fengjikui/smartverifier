import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { InspectionService, person } from '../server/service.ts';
import { LocalVisionPipeline, instructionPriorityWarnings, parsePairReply, RecognitionProblem } from '../server/vision/local-pipeline.ts';
import type { VisionPipeline } from '../server/vision/local-pipeline.ts';
import type { ComponentResult, Photo, Round } from '../shared/types.ts';

const item={componentId:'c1',status:'decided',verdict:'FAIL',lines:['SV385','A26','0147'],confidence:.9,reason:'型号错序',features:['8脚'],differences:[]};
test('真实模型响应只接受完整JSON或一层围栏；串号、漏项、思考文本和坏置信度均拒绝',()=>{
  const good=JSON.stringify({items:[item],instructionConflicts:[]});
  assert.equal(parsePairReply('```json\n'+good+'\n```','c1').items[0].verdict,'FAIL');
  for(const response of [good.replace('c1','c2'),JSON.stringify({items:[]}),'<think>猜测</think>'+good,good.replace('0.9','1.9'),good.slice(0,-1),JSON.stringify([item])])assert.throws(()=>parsePairReply(response,'c1'));
  const override=parsePairReply(JSON.stringify({items:[{...item,verdict:'PASS',differences:[{category:'text',message:'允许型号变化',lineIndex:0,referenceText:'SV358',sampleText:'SV385'}]}],instructionConflicts:[]}),'c1');
  assert.equal(instructionPriorityWarnings('允许型号变体',override).length,1);assert.equal(override.instructionConflicts.length,0,'保留模型实际漏报，系统提示另存');assert.equal(instructionPriorityWarnings('',override).length,0);
});

test('正常识别默认发送固定前缀与实际Schema，兼容显式旧配置且不默默降级',async t=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),directory=await mkdtemp(path.join(tmpdir(),'sv-order-contract-'));
  const pipeline=new LocalVisionPipeline(root,directory),service=new InspectionService(directory,root,1,pipeline);
  t.after(async()=>{service.closing=true;service.store.close();await rm(directory,{recursive:true,force:true});});
  let view=service.open('REALVISION1');view=await service.addRealTrial(view.round!.id,view.round!.revision,person);
  const photo=view.round!.photos[0],component:ComponentResult={id:'c1',label:'P001-01',index:0,bbox:[0,0,1,1],ai:null,aiHistory:[],review:null,reviewHistory:[],crop:{assetId:photo.file,url:photo.url,width:photo.width,height:photo.height,rotation:0,qualityReasons:[]}};
  let request:Record<string,unknown>={};
  pipeline.worker=async input=>{request=input;return {model:'fixture',elapsedMs:1,promptVersion:'test',response:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[item],instructionConflicts:[]})}}]}};};
  await pipeline.recognize(view.round!,photo,component);
  assert.equal(request.inputLayout,'prefix-first');assert.deepEqual((request.responseSchema as {properties:{items:{items:{properties:{componentId:{enum:string[]}}}}}}).properties.items.items.properties.componentId.enum,['c1']);
  pipeline.inputLayout='legacy';pipeline.structured=false;await pipeline.recognize(view.round!,photo,component);
  assert.equal(request.inputLayout,'legacy');assert.equal('responseSchema' in request,false);
  pipeline.worker=async()=>{throw new RecognitionProblem('error','Schema请求失败');};
  pipeline.structured=true;await assert.rejects(pipeline.recognize(view.round!,photo,component),/Schema请求失败/);
});

test('接入真实管线的业务状态：增量、质量、失败重试、说明重判、原判追溯及提交阻断',async t=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),directory=await mkdtemp(path.join(tmpdir(),'sv-real-adapter-'));
  let preparations=0,calls=0,failure:'none'|'quality'|'transport'='none';
  const pipeline:VisionPipeline={model:'fake-for-state-test',async prepare(photo:Photo){preparations++;return {preparation:{version:'test',sourceHash:photo.hash,uprightUrl:photo.url,annotatedUrl:photo.url,sheetUrl:photo.url,width:1536,height:1024,elapsedMs:1,coverage:'complete',issues:[]},components:[{id:'C'+photo.id,label:'P'+photo.sequence+'-01',index:0,bbox:[0,0,1,1],ai:null,aiHistory:[],review:null,reviewHistory:[],crop:{url:photo.url,assetId:photo.file,width:1536,height:1024,rotation:0,qualityReasons:[]}}]};},async recognize(round:Round,_photo:Photo,_component:ComponentResult){calls++;if(failure==='quality')throw new RecognitionProblem('quality','图片质量过低，请重新拍照');if(failure==='transport')throw new RecognitionProblem('error','模型断开连接，请重试');return {verdict:round.instruction?'PASS':'FAIL',lines:['SV385','A26','0147'],confidence:.92,reason:round.instruction?'按现场说明忽略型号':'型号不一致',instructionVersion:round.instructionVersion,source:'lmstudio',model:'fake-for-state-test',instructionConflicts:round.instruction?['现场允许忽略型号与标准冲突']:[]};}};
  const service=new InspectionService(directory,root,1,pipeline);
  t.after(async()=>{service.closing=true;while(service.worker)await delay(5);service.store.close();await rm(directory,{recursive:true,force:true});});
  let view=service.open('REALVISION2');view=await service.addRealTrial(view.round!.id,view.round!.revision,person);assert.equal(view.round!.photos[0].sample,null);
  async function analyze(){service.analyze(view.round!.id,view.round!.revision);while(service.worker)await delay(5);view=service.view(view.task.id);}
  await analyze();assert.equal(view.summary!.fail,1);assert.equal(view.summary!.canSubmit,true);assert.equal(calls,1);
  const first=structuredClone(view.round!.photos[0]);
  // 即使上传字节与旧预设样例相同，也必须走真实适配器，不能按hash偷换为预设。
  view=await service.addPhoto(view.round!.id,view.round!.revision,{bytes:await readFile(path.join(root,'fixtures/inspection/reference.png')),filename:'upload.png',width:1536,height:1024},person);
  assert.equal(view.round!.photos[1].sample,null);failure='transport';await analyze();assert.equal(view.summary!.failedPhotos,1);assert.equal(view.summary!.canSubmit,false);assert.deepEqual(view.round!.photos[0],first);
  assert.throws(()=>service.submit(view.round!.id,view.round!.revision,person),/不能部分提交/);
  failure='none';await analyze();assert.equal(calls,3);assert.equal(preparations,2,'重试复用裁片');assert.equal(view.summary!.total,2);
  view=service.notes(view.round!.id,view.round!.revision,'本次允许忽略型号',person);await analyze();assert.equal(view.summary!.fail,0);assert.equal(preparations,2);assert.equal(view.round!.photos[0].components[0].aiHistory.length,2);assert.equal(view.round!.photos[0].components[0].aiHistory[0].verdict,'FAIL');
  assert.match(service.report(view.round!),/重要：现场说明/);assert.match(service.report(view.round!),/VLM真实识别/);
  view=service.notes(view.round!.id,view.round!.revision,'新说明',person);failure='quality';await analyze();assert.equal(view.summary!.qualityPhotos,2);assert.equal(view.summary!.canSubmit,false);assert.equal(view.summary!.completed,0);
  const sequence=view.round!.photos[0].sequence;view=await service.addPhoto(view.round!.id,view.round!.revision,{bytes:await readFile(path.join(root,'fixtures/inspection/green-mat-v1/single.png')),filename:'replacement.png',width:1536,height:1024,replaceId:view.round!.photos[0].id},person);assert.equal(view.round!.photos.length,2);assert.equal(view.round!.photos[0].sequence,sequence);
  failure='none';await analyze();service.submit(view.round!.id,view.round!.revision,person);while(service.view(view.task.id).round!.status==='submitting')await delay(5);
  view=service.newRound(view.task.id,true);assert.equal(view.round!.photos.length,2);assert.equal(view.round!.photos[0].preparation,undefined,'新轮次不可使用旧元件身份的空结果');await analyze();assert.equal(view.summary!.completed,2);assert.equal(preparations,5);
});

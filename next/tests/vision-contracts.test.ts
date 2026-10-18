import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateProfile, planBatches, qwenPatch32Estimate } from '../server/vision/batching.ts';
import { prepareRecognitionRequest } from '../server/vision/preparation.ts';
import { validateExecution, validateModelReply, validateSeparation } from '../server/vision/validation.ts';
import { protocol } from '../server/vision/contracts.ts';
import type { AnalysisScope, ComposedSheet, ImageAsset, InspectionBasis, Layout, Matrix3, ModelProfile, ModelReply, PhotoInput, PreparedComponent, RecognitionExecution, RecognitionRequest, SeparationResult } from '../server/vision/contracts.ts';

const identity: Matrix3 = [1,0,0,0,1,0,0,0,1];
const sourceHash = 'a'.repeat(64);
const scope: AnalysisScope = { taskId:'t1', roundId:'r1', snapshotId:'s1', standardId:'std1', standardVersion:1, instructionVersion:1 };
function image(assetId: string, width = 256, height = 128): ImageAsset {
  return { assetId, sha256:sourceHash, mime:'image/png', width, height, bytes:1024 };
}
function basis(): InspectionBasis {
  return { referenceImage:image('reference'), standardDescription:'日期码允许变化', onsiteInstruction:'', promptVersion:'p1', precedence:'onsite_over_standard' };
}
function component(n: number, width = 256, height = 128): PreparedComponent {
  return { componentId:`c${n}`, photoId:'photo1', photoVersion:1, sourceSha256:sourceHash,
    quadPx:[[0,0],[width,0],[width,height],[0,height]], modelView:image(`crop${n}`,width,height),
    viewToUprightOriginal:identity, rotationClockwiseDegrees:0, quality:{state:'usable',reasons:[]}, routeHint:'unclassified' };
}
function plan(count: number, layout: Layout = 'separate_images', profile: ModelProfile = candidateProfile) {
  return planBatches({ scope, basis:basis(), components:Array.from({length:count},(_,i)=>component(i+1)), profile, layout, estimateImageTokens:qwenPatch32Estimate });
}
function request(): RecognitionRequest {
  return prepareRecognitionRequest(plan(2).batches[0], basis());
}
function reply(req = request()): ModelReply {
  return { items:req.batch.components.map(c=>({componentId:c.componentId,status:'decided',verdict:'PASS',lines:['SV358'],confidence:.98,reason:'符合标准',features:[],differences:[]})), instructionConflicts:[] };
}
function execution(req: RecognitionRequest): RecognitionExecution {
  return { protocol,batchId:req.batch.batchId,attemptId:req.batch.attemptId,scope:structuredClone(scope),
    adapterId:req.batch.adapterId,modelId:'test-model',profileId:req.batch.profileId,profileVersion:req.batch.profileVersion,mode:req.batch.mode,
    preprocessingVersion:'v1',elapsedMs:1000,rawResponseAssetId:'raw1',
    inputMetrics:[req.basis.referenceImage,...req.sampleImages].map((img,inputIndex)=>({ inputIndex,assetId:img.assetId,sentWidth:img.width,sentHeight:img.height,effectiveWidth:null,effectiveHeight:null })),reply:reply(req) };
}
function photo(): PhotoInput { return {photoId:'photo1',photoVersion:1,original:image('original',1600,1200),upright:image('upright',1600,1200),originalToUpright:identity}; }
function separation(): SeparationResult { return {protocol,photoId:'photo1',photoVersion:1,sourceSha256:sourceHash,separatorId:'test-separator',separatorVersion:'v1',preprocessingVersion:'v1',status:'completed',coverage:'complete',components:[component(1)],issues:[]}; }
function code(expected: string) { return (error: unknown) => (error as {code?: string})?.code === expected; }

test('六元件独立传图按4+2分批，参考图计入每批总数；最多4张总图时改为3+3',()=>{
  const result=plan(6); assert.deepEqual(result.batches.map(b=>b.components.length),[4,2]);
  assert.deepEqual(result.batches.map(b=>b.modelInputImageCount),[5,3]);assert.equal(result.blocked.length,0);
  const profile=structuredClone(candidateProfile);profile.limits.maxTotalImages=4;
  assert.deepEqual(plan(6,'separate_images',profile).batches.map(b=>b.components.length),[3,3]);
  assert.notEqual(result.batches[0].batchId,result.batches[1].batchId);
});
test('六元件可拼成一张样品图；第七件单独分批，标签保留在裁片上方',()=>{
  const result=plan(7,'contact_sheet');assert.deepEqual(result.batches.map(b=>b.components.length),[6,1]);
  for(const b of result.batches){assert.equal(b.modelInputImageCount,2);const sheet=b.sheet!;assert.equal(sheet.scale,1);
    for(const [i,p] of sheet.placements.entries()) { const crop=b.components[i].modelView;assert.equal(p.width,crop.width);assert.equal(p.height,crop.height);
      assert.ok(p.y>=sheet.labelHeight);assert.ok(p.x+p.width<=sheet.width);assert.ok(p.y+p.height<=sheet.height);
      for(const q of sheet.placements.slice(i+1)) assert.ok(p.x+p.width<=q.x || q.x+q.width<=p.x || p.y+p.height<=q.y-sheet.labelHeight || q.y+q.height<=p.y-sheet.labelHeight);
    }
  }
});
test('预算包含参考图，超预算时拆批；大裁片只拆批不静默缩小',()=>{
  const p=structuredClone(candidateProfile);p.limits.maxEstimatedVisualTokens=3*qwenPatch32Estimate(256,128);
  assert.deepEqual(plan(4,'separate_images',p).batches.map(b=>b.components.length),[2,2]);
  const large=planBatches({scope,basis:basis(),components:[component(1,1200,1100),component(2,1200,1100)],profile:candidateProfile,layout:'contact_sheet',estimateImageTokens:qwenPatch32Estimate});
  assert.deepEqual(large.batches.map(b=>b.components.length),[1,1]);
  assert.ok(large.batches.every(b=>b.sheet?.placements[0].width===1200));
});
test('相同像素哈希不合并元件，重复身份拒绝；需重拍元件和超限元件不生成判定',()=>{
  assert.equal(plan(6,'contact_sheet').batches[0].components.length,6);
  const input={scope,basis:basis(),components:[component(1),component(1)],profile:candidateProfile,layout:'separate_images' as const,estimateImageTokens:qwenPatch32Estimate};
  assert.throws(()=>planBatches(input),code('DUPLICATE_COMPONENT'));
  const poor=component(1);poor.quality={state:'needs_recapture',reasons:['文字区域失焦']};
  const unknown=component(2);unknown.quality.state='undetermined';
  const result=planBatches({...input,components:[poor,unknown,component(3,3000,1000)]});
  assert.deepEqual(result.batches.flatMap(b=>b.components.map(c=>c.componentId)),['c2']);
  assert.deepEqual(result.blocked.map(b=>b.code),['NEEDS_RECAPTURE','REQUIRES_PREPROCESSING_OR_PROFILE']);
});
test('不支持的布局、过大参考图及无效预算估算不能偷偷降级执行',()=>{
  const p=structuredClone(candidateProfile);p.layouts=['separate_images'];
  assert.throws(()=>plan(1,'contact_sheet',p),code('UNSUPPORTED_LAYOUT'));
  const input={scope,basis:basis(),components:[component(1)],profile:candidateProfile,layout:'separate_images' as const,estimateImageTokens:qwenPatch32Estimate};
  assert.throws(()=>planBatches({...input,basis:{...basis(),referenceImage:image('ref',4000,3000)}}),code('REFERENCE_REQUIRES_PREPROCESSING'));
  assert.throws(()=>planBatches({...input,estimateImageTokens:()=>NaN}),code('INVALID_TOKEN_ESTIMATE'));
  assert.throws(()=>planBatches({...input,estimateImageTokens:()=>6144}),code('REFERENCE_BUDGET_EXCEEDED'));
});
test('实际拼图必须符合编号及尺寸计划，识别请求携带生成后的图片引用',()=>{
  const batch=plan(6,'contact_sheet').batches[0],sheet=batch.sheet!;
  const composed:ComposedSheet={batchId:batch.batchId,image:image('sheet',sheet.width,sheet.height),placements:structuredClone(sheet.placements)};
  assert.throws(()=>prepareRecognitionRequest(batch,basis()),code('SHEET_REQUIRED'));
  const req=prepareRecognitionRequest(batch,basis(),composed);assert.deepEqual(req.sampleImages,[composed.image]);
  const wrong=structuredClone(composed);wrong.placements[0].componentId='c6';
  assert.throws(()=>prepareRecognitionRequest(batch,basis(),wrong),code('SHEET_PLAN_MISMATCH'));
  assert.throws(()=>prepareRecognitionRequest(batch,basis(),{...composed,image:{...composed.image,width:100}}),code('SHEET_PLAN_MISMATCH'));
  assert.throws(()=>prepareRecognitionRequest(plan(1).batches[0],basis(),composed),code('UNEXPECTED_SHEET'));
});
test('分批后换参考图、检测说明或提示词版本，必须重新计划',()=>{
  const batch=plan(1).batches[0];
  assert.throws(()=>prepareRecognitionRequest(batch,{...basis(),referenceImage:image('other')}),code('REFERENCE_MISMATCH'));
  for(const changed of [{onsiteInstruction:'忽略日期码'},{standardDescription:'核对所有字'},{promptVersion:'p2'}])
    assert.throws(()=>prepareRecognitionRequest(batch,{...basis(),...changed}),code('BASIS_MISMATCH'));
});
test('模型乱序返回按身份归位；漏项、重号、额外元件均拒绝',()=>{
  const req=request(),valid=reply(req);valid.items.reverse();
  assert.deepEqual(validateModelReply(req.batch,valid).items.map(i=>i.componentId),['c1','c2']);
  assert.throws(()=>validateModelReply(req.batch,{...valid,items:[valid.items[0]]}),code('MISSING_RESULT'));
  assert.throws(()=>validateModelReply(req.batch,{...valid,items:[valid.items[0],valid.items[0]]}),code('DUPLICATE_RESULT'));
  assert.throws(()=>validateModelReply(req.batch,{...valid,items:[valid.items[0],{...valid.items[1],componentId:'unknown'}]}),code('UNKNOWN_COMPONENT'));
});
test('严格JSON协议拒绝根数组、错误置信度和不支持的结论；看不清不等于不合格',()=>{
  const req=request(),valid=reply(req);
  assert.throws(()=>validateModelReply(req.batch,valid.items));
  for(const patch of [{confidence:1.2},{verdict:'UNCERTAIN'},{status:'unreadable',verdict:'FAIL'}])
    assert.throws(()=>validateModelReply(req.batch,{...valid,items:[{...valid.items[0],...patch},valid.items[1]]}));
  const unreadable={...valid,items:[{...valid.items[0],status:'unreadable',verdict:null},valid.items[1]]};
  assert.equal(validateModelReply(req.batch,unreadable).items[0].verdict,null);
  assert.equal(validateModelReply(req.batch,{...valid,items:[{...valid.items[0],confidence:.4},valid.items[1]]}).items[0].verdict,'PASS');
});
test('分离结果绑定原图版本，坐标越界、非凸四边形及不可逆变换均拒绝',()=>{
  const input=photo();assert.equal(validateSeparation(input,separation()).components.length,1);
  assert.throws(()=>validateSeparation({...input,photoVersion:2},separation()),code('STALE_INPUT'));
  assert.throws(()=>validateSeparation({...input,original:{...input.original,sha256:'b'.repeat(64)}},separation()),code('STALE_INPUT'));
  const bad=separation();bad.components[0].quadPx[0]=[-1,0];assert.throws(()=>validateSeparation(input,bad),code('INVALID_REGION'));
  const crossed=separation();crossed.components[0].quadPx=[[0,0],[256,128],[256,0],[0,128]];assert.throws(()=>validateSeparation(input,crossed),code('INVALID_REGION'));
  const degenerate=separation();degenerate.components[0].viewToUprightOriginal=[0,0,0,0,0,0,0,0,0];assert.throws(()=>validateSeparation(input,degenerate),code('INVALID_TRANSFORM'));
});
test('空分离或覆盖不明确不能称为完成；质量失败保留状态，不生成虚假元件',()=>{
  assert.throws(()=>validateSeparation(photo(),{...separation(),components:[]}),code('INCOMPLETE_SEPARATION'));
  assert.throws(()=>validateSeparation(photo(),{...separation(),coverage:'uncertain'}),code('INCOMPLETE_SEPARATION'));
  const failed={...separation(),status:'recapture_required',coverage:'uncertain',components:[],issues:[{code:'BLUR',message:'图片质量过低，请重新拍照',componentIds:[]}]};
  assert.equal(validateSeparation(photo(),failed).status,'recapture_required');
  assert.throws(()=>validateSeparation(photo(),{...separation(),issues:[{code:'MISSING',message:'未知',componentIds:['c99']}]}),code('UNKNOWN_COMPONENT'));
});
test('旧说明、旧快照、旧重试及换模型的迟到结果不能写回',()=>{
  const req=request(),done=execution(req);assert.equal(validateExecution(req,done,scope).items.length,2);
  for(const changed of [{instructionVersion:2},{standardVersion:2},{snapshotId:'new'},{roundId:'r2'}])
    assert.throws(()=>validateExecution(req,done,{...scope,...changed}),code('STALE_INPUT'));
  assert.throws(()=>validateExecution(req,{...done,attemptId:'old'},scope),code('STALE_INPUT'));
  for(const changed of [{adapterId:'other'},{profileVersion:'v2'},{mode:'real'}])
    assert.throws(()=>validateExecution(req,{...done,...changed},scope),code('PROFILE_MISMATCH'));
});
test('审计包含参考图与所有实际输入尺寸；未知模型内部尺寸明确记为null',()=>{
  const req=request(),done=execution(req);assert.equal(done.inputMetrics[0].assetId,'reference');
  assert.equal(validateExecution(req,done,scope).items.length,2);
  const wrong=structuredClone(done);wrong.inputMetrics[1].sentWidth=32;
  assert.throws(()=>validateExecution(req,wrong,scope),code('INPUT_METRICS_MISMATCH'));
  assert.throws(()=>validateExecution(req,{...done,inputMetrics:done.inputMetrics.slice(1)},scope),code('INPUT_METRICS_MISMATCH'));
  const incomplete=structuredClone(done);incomplete.inputMetrics[0].effectiveWidth=256;
  assert.throws(()=>validateExecution(req,incomplete,scope));
});

import { executionSchema, modelReplySchema, photoInputSchema, protocol, separationSchema, VisionContractError } from './contracts.ts';
import type { AnalysisScope, Matrix3, ModelReply, PhotoInput, PlannedBatch, RecognitionRequest, SeparationResult } from './contracts.ts';

function invertible(m: Matrix3) {
  const [a,b,c,d,e,f,g,h,i] = m;
  return Math.abs(a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g)) > 1e-10;
}
export function validateSeparation(input: PhotoInput, raw: unknown): SeparationResult {
  const photo = photoInputSchema.parse(input), result = separationSchema.parse(raw);
  if (!invertible(photo.originalToUpright)) throw new VisionContractError('INVALID_TRANSFORM', '原图方向变换不可逆。');
  if (result.photoId !== photo.photoId || result.photoVersion !== photo.photoVersion || result.sourceSha256 !== photo.original.sha256)
    throw new VisionContractError('STALE_INPUT', '分离结果不属于当前原图版本。');
  const ids = new Set<string>();
  for (const component of result.components) {
    if (ids.has(component.componentId)) throw new VisionContractError('DUPLICATE_COMPONENT', '分离器返回重复元件编号。');
    ids.add(component.componentId);
    if (component.photoId !== photo.photoId || component.photoVersion !== photo.photoVersion || component.sourceSha256 !== photo.original.sha256)
      throw new VisionContractError('STALE_INPUT', '元件与原图版本不匹配。');
    if (component.quadPx.some(([x,y]) => x < 0 || y < 0 || x > photo.upright.width || y > photo.upright.height))
      throw new VisionContractError('INVALID_REGION', '元件坐标必须使用方向纠正后原图的像素坐标。');
    const crossProducts = component.quadPx.map((p, j, points) => {
      const q = points[(j+1)%4], r = points[(j+2)%4];
      return (q[0]-p[0])*(r[1]-q[1])-(q[1]-p[1])*(r[0]-q[0]);
    });
    if (!crossProducts.every(n => n > 0) && !crossProducts.every(n => n < 0))
      throw new VisionContractError('INVALID_REGION', '元件四角须按边界顺序组成非退化凸四边形。');
    if (!invertible(component.viewToUprightOriginal)) throw new VisionContractError('INVALID_TRANSFORM', '裁片反向映射无效。');
  }
  if (result.status === 'completed' && (!result.components.length || result.coverage !== 'complete'))
    throw new VisionContractError('INCOMPLETE_SEPARATION', '空结果或覆盖不明确不能标记为完整分离。');
  for (const issue of result.issues) if (issue.componentIds.some(id => !ids.has(id))) throw new VisionContractError('UNKNOWN_COMPONENT', '分离问题指向未知元件。');
  return result;
}

export function validateModelReply(batch: PlannedBatch, raw: unknown): ModelReply {
  return validateReplyItems(batch.components.map(c=>c.componentId),raw);
}

export function validateReplyItems(componentIds: string[], raw: unknown): ModelReply {
  // 不把数组自动包装为对象；结构错误保留原文，按协议失败处理。
  const reply = modelReplySchema.parse(raw), expected = new Set(componentIds);
  if(!componentIds.length||expected.size!==componentIds.length)throw new VisionContractError('INVALID_EXPECTED_IDS','输入元件编号必须非空且不重复。');
  const actual = reply.items.map(item => item.componentId);
  if (new Set(actual).size !== actual.length) throw new VisionContractError('DUPLICATE_RESULT', '模型返回重复元件编号。');
  if (actual.some(id => !expected.has(id))) throw new VisionContractError('UNKNOWN_COMPONENT', '模型返回了输入中不存在的元件。');
  if (actual.length !== expected.size) throw new VisionContractError('MISSING_RESULT', '模型漏回元件结果，不能当作完整批次。');
  // 模型返回顺序可以不同，写回必须按ID匹配；不能按数组位置串号。
  return { ...reply, items: componentIds.map(id => reply.items.find(item => item.componentId === id)!) };
}

function sameScope(a: AnalysisScope, b: AnalysisScope) {
  return a.taskId === b.taskId && a.roundId === b.roundId && a.snapshotId === b.snapshotId &&
    a.standardId === b.standardId && a.standardVersion === b.standardVersion && a.instructionVersion === b.instructionVersion;
}
export function validateExecution(request: RecognitionRequest, raw: unknown, currentScope: AnalysisScope): ModelReply {
  const batch = request.batch, execution = executionSchema.parse(raw);
  if (execution.protocol !== protocol || execution.batchId !== batch.batchId || execution.attemptId !== batch.attemptId ||
      !sameScope(batch.scope, execution.scope) || !sameScope(batch.scope, currentScope))
    throw new VisionContractError('STALE_INPUT', '结果来自旧输入、旧批次或旧重试，拒绝写回。');
  if (execution.adapterId !== batch.adapterId || execution.profileId !== batch.profileId || execution.profileVersion !== batch.profileVersion || execution.mode !== batch.mode)
    throw new VisionContractError('PROFILE_MISMATCH', '识别结果的能力配置或模拟标记不匹配。');
  const inputs = [request.basis.referenceImage, ...request.sampleImages];
  if (execution.inputMetrics.length !== inputs.length || execution.inputMetrics.some((metric, i) => {
    const expected = inputs[i];
    return metric.inputIndex !== i || metric.assetId !== expected.assetId || metric.sentWidth !== expected.width || metric.sentHeight !== expected.height;
  })) throw new VisionContractError('INPUT_METRICS_MISMATCH', '输入图片记录与实际请求不一致，禁止静默换图或缩图。');
  return validateModelReply(batch, execution.reply);
}

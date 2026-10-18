import { basisSchema, imageSchema, VisionContractError } from './contracts.ts';
import type { ComposedSheet, ImageAsset, InspectionBasis, PlannedBatch, RecognitionRequest } from './contracts.ts';
import { inspectionBasisDigest } from './fingerprint.ts';

function sameImage(a: ImageAsset, b: ImageAsset) {
  return a.assetId === b.assetId && a.sha256 === b.sha256 && a.mime === b.mime && a.width === b.width && a.height === b.height && a.bytes === b.bytes;
}

/** 拼图产物必须与计划逐项一致；图片像素与hash由资产服务验证，这里验证引用和布局。 */
export function prepareRecognitionRequest(batch: PlannedBatch, rawBasis: InspectionBasis, composed?: ComposedSheet): RecognitionRequest {
  const basis = basisSchema.parse(rawBasis);
  if (!sameImage(basis.referenceImage, batch.referenceImage))
    throw new VisionContractError('REFERENCE_MISMATCH', '识别依据中的参考图与分批时不一致。');
  if (inspectionBasisDigest(basis) !== batch.basisSha256)
    throw new VisionContractError('BASIS_MISMATCH', '分批后检测说明或提示词依据发生变化，需要重新计划。');
  let sampleImages: ImageAsset[];
  if (batch.layout === 'separate_images') {
    if (composed || batch.sheet) throw new VisionContractError('UNEXPECTED_SHEET', '独立图片模式不接收拼图。');
    sampleImages = batch.components.map(c => c.modelView);
  } else {
    if (!composed || !batch.sheet) throw new VisionContractError('SHEET_REQUIRED', '拼图模式需要先生成实际图片。');
    const image = imageSchema.parse(composed.image), plan = batch.sheet;
    if (composed.batchId !== batch.batchId || image.width !== plan.width || image.height !== plan.height ||
        composed.placements.length !== plan.placements.length || composed.placements.some((p, i) => {
          const expected = plan.placements[i];
          return p.componentId !== expected.componentId || p.label !== expected.label || p.x !== expected.x || p.y !== expected.y || p.width !== expected.width || p.height !== expected.height;
        })) throw new VisionContractError('SHEET_PLAN_MISMATCH', '拼图尺寸、元件编号或位置与计划不一致。');
    sampleImages = [image];
  }
  if (sampleImages.length + 1 !== batch.modelInputImageCount)
    throw new VisionContractError('INPUT_COUNT_MISMATCH', '模型输入图片数量与计划不一致。');
  return { batch, basis, sampleImages };
}

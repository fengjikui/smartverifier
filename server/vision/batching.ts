import { randomUUID } from 'node:crypto';
import { basisSchema, componentSchema, profileSchema, protocol, scopeSchema, VisionContractError } from './contracts.ts';
import type { AnalysisScope, ImageAsset, InspectionBasis, Layout, ModelProfile, PlannedBatch, PreparedComponent, SheetPlan } from './contracts.ts';
import { inspectionBasisDigest } from './fingerprint.ts';

export type ImageTokenEstimator = (width: number, height: number) => number;
/** 本机千问处理器的近似值；其他模型必须换估算器，执行前仍由适配器preflight。 */
export const qwenPatch32Estimate: ImageTokenEstimator = (width, height) => {
  const scale = Math.max(1, Math.sqrt(65536 / (width * height)));
  return Math.max(32, Math.round(width * scale / 32) * 32) * Math.max(32, Math.round(height * scale / 32) * 32) / 1024;
};

function fitsImage(image: Pick<ImageAsset, 'width' | 'height'>, profile: ModelProfile) {
  return Math.max(image.width, image.height) <= profile.limits.maxImageLongEdge && image.width * image.height <= profile.limits.maxImagePixels;
}
/** 尝试每种列数，选择满足预算且最接近方形的布局，不裁边或缩放。 */
function sheetPlan(components: PreparedComponent[], profile: ModelProfile): SheetPlan | null {
  const gap = 16, labelHeight = 32;
  const cellWidth = Math.max(64, ...components.map(c => c.modelView.width));
  const cellHeight = Math.max(...components.map(c => c.modelView.height)) + labelHeight;
  const candidates: SheetPlan[] = [];
  for (let columns = 1; columns <= components.length; columns++) {
    const rows = Math.ceil(components.length / columns);
    const width = columns * cellWidth + (columns + 1) * gap, height = rows * cellHeight + (rows + 1) * gap;
    if (!fitsImage({ width, height }, profile)) continue;
    candidates.push({ width, height, labelHeight, scale: 1, placements: components.map((c, i) => ({
      componentId: c.componentId, label: `C${String(i + 1).padStart(2, '0')}`, x: gap + (i % columns) * (cellWidth + gap),
      y: gap + Math.floor(i / columns) * (cellHeight + gap) + labelHeight,
      width: c.modelView.width, height: c.modelView.height,
    })) });
  }
  return candidates.sort((a, b) => Math.abs(Math.log(a.width / a.height)) - Math.abs(Math.log(b.width / b.height)) || a.width * a.height - b.width * b.height)[0] ?? null;
}

export function planBatches(input: {
  scope: AnalysisScope; basis: InspectionBasis; components: PreparedComponent[]; profile: ModelProfile;
  layout: Layout; estimateImageTokens: ImageTokenEstimator;
}): { batches: PlannedBatch[]; blocked: { componentId: string; code: string; message: string }[] } {
  const scope = scopeSchema.parse(input.scope), basis = basisSchema.parse(input.basis), profile = profileSchema.parse(input.profile);
  if (!profile.layouts.includes(input.layout)) throw new VisionContractError('UNSUPPORTED_LAYOUT', '当前识别适配器不支持此图片布局。');
  const components = input.components.map(c => componentSchema.parse(c));
  if (new Set(components.map(c => c.componentId)).size !== components.length) throw new VisionContractError('DUPLICATE_COMPONENT', '输入元件编号重复，不能按图片哈希合并。');
  if (!fitsImage(basis.referenceImage, profile)) throw new VisionContractError('REFERENCE_REQUIRES_PREPROCESSING', '参考图需要先按明确策略生成模型裁片，不能隐式缩图。');
  function tokens(width: number, height: number) {
    const count = input.estimateImageTokens(width, height);
    if (!Number.isFinite(count) || count <= 0) throw new VisionContractError('INVALID_TOKEN_ESTIMATE', '视觉预算估算器返回无效数值。');
    return count;
  }
  const referenceTokens = tokens(basis.referenceImage.width, basis.referenceImage.height);
  if (referenceTokens >= profile.limits.maxEstimatedVisualTokens) throw new VisionContractError('REFERENCE_BUDGET_EXCEEDED', '参考图已占满视觉预算。');
  const batches: PlannedBatch[] = [], blocked: { componentId: string; code: string; message: string }[] = [];
  function candidate(group: PreparedComponent[]): Omit<PlannedBatch, 'batchId' | 'attemptId'> | null {
    if (group.length > profile.limits.maxComponents || group.some(c => !fitsImage(c.modelView, profile))) return null;
    const sheet = input.layout === 'contact_sheet' ? sheetPlan(group, profile) : null;
    if (input.layout === 'contact_sheet' && !sheet) return null;
    const sampleImages = sheet ? 1 : group.length;
    if (sampleImages > profile.limits.maxSampleImages || sampleImages + 1 > profile.limits.maxTotalImages) return null;
    const estimatedVisualTokens = referenceTokens + (sheet ? tokens(sheet.width, sheet.height) : group.reduce((sum, c) => sum + tokens(c.modelView.width, c.modelView.height), 0));
    if (estimatedVisualTokens > profile.limits.maxEstimatedVisualTokens) return null;
    return { protocol, scope, adapterId: profile.adapterId, profileId: profile.profileId, profileVersion: profile.profileVersion, mode: profile.mode,
      basisSha256: inspectionBasisDigest(basis),
      layout: input.layout, referenceImage: basis.referenceImage, components: group, sheet, estimatedVisualTokens, modelInputImageCount: sampleImages + 1 };
  }
  function emit(group: PreparedComponent[]) {
    if (!group.length) return;
    batches.push({ ...candidate(group)!, batchId: randomUUID(), attemptId: randomUUID() });
  }
  let current: PreparedComponent[] = [];
  for (const component of components) {
    if (component.quality.state === 'needs_recapture') {
      blocked.push({ componentId: component.componentId, code: 'NEEDS_RECAPTURE', message: component.quality.reasons.join('；') || '图片质量过低，请重新拍照。' });
      continue;
    }
    if (!candidate([component])) {
      blocked.push({ componentId: component.componentId, code: 'REQUIRES_PREPROCESSING_OR_PROFILE', message: '单件仍超出当前图片或视觉预算，请显式调整处理策略或模型配置。' });
      continue;
    }
    if (current.length && !candidate([...current, component])) { emit(current); current = []; }
    current.push(component);
  }
  emit(current);
  return { batches, blocked };
}

/** 候选能力上限，不是实拍验收结论。4张待检图 + 1张参考图，或一张最多6件的拼图。 */
export const candidateProfile: ModelProfile = {
  profileId: 'candidate-vlm', profileVersion: 'v1-assumed', adapterId: 'not-connected', mode: 'mock',
  layouts: ['separate_images', 'contact_sheet'],
  limits: { maxSampleImages: 4, maxComponents: 6, maxTotalImages: 5, maxImageLongEdge: 2048,
    maxImagePixels: 2048 * 2048, maxEstimatedVisualTokens: 6144 },
};

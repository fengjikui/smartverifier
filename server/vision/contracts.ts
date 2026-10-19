/** 识别链路 v1 合同。文件引用由业务服务解析；不接收任意路径或远程 URL。 */
import { z } from 'zod';

export const protocol = 'sv.vision.v1' as const;
const id = z.string().min(1).max(200);
const version = z.number().int().positive();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
export const matrixSchema = z.tuple([finite, finite, finite, finite, finite, finite, finite, finite, finite]);
const point = z.tuple([finite, finite]);
export const imageSchema = z.object({
  assetId: id, sha256, mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  width: z.number().int().positive().max(30000), height: z.number().int().positive().max(30000),
  bytes: z.number().int().positive(),
}).strict();
export const photoInputSchema = z.object({
  photoId: id, photoVersion: version, original: imageSchema, upright: imageSchema,
  originalToUpright: matrixSchema,
}).strict();
export const componentSchema = z.object({
  componentId: id, photoId: id, photoVersion: version, sourceSha256: sha256,
  // 坐标：EXIF纠正后的全分辨率原图，左上原点，x向右/y向下，单位像素。
  quadPx: z.tuple([point, point, point, point]),
  modelView: imageSchema, viewToUprightOriginal: matrixSchema,
  rotationClockwiseDegrees: finite.min(-180).max(180),
  quality: z.object({ state: z.enum(['usable', 'undetermined', 'needs_recapture']), reasons: z.array(z.string()) }).strict(),
  // 只是分流提示，不是结论；未分类不自动等于简单。
  routeHint: z.enum(['unclassified', 'standard', 'complex']),
}).strict();
export const separationSchema = z.object({
  protocol: z.literal(protocol), photoId: id, photoVersion: version, sourceSha256: sha256,
  separatorId: id, separatorVersion: id, preprocessingVersion: id,
  status: z.enum(['completed', 'recapture_required', 'failed']),
  coverage: z.enum(['complete', 'uncertain']), components: z.array(componentSchema),
  issues: z.array(z.object({ code: id, message: z.string(), componentIds: z.array(id) }).strict()),
}).strict();
export const scopeSchema = z.object({
  taskId: id, roundId: id, snapshotId: id,
  standardId: id, standardVersion: version, instructionVersion: version,
}).strict();
export const basisSchema = z.object({
  referenceImage: imageSchema, standardDescription: z.string().max(20000),
  onsiteInstruction: z.string().max(4000), promptVersion: id,
  precedence: z.literal('onsite_over_standard'),
}).strict();
export const profileSchema = z.object({
  profileId: id, profileVersion: id, adapterId: id, mode: z.enum(['mock', 'real']),
  layouts: z.array(z.enum(['separate_images', 'contact_sheet'])).min(1),
  limits: z.object({
    maxSampleImages: z.number().int().positive(), maxComponents: z.number().int().positive(),
    maxTotalImages: z.number().int().min(2), maxImageLongEdge: z.number().int().positive(),
    maxImagePixels: z.number().int().positive(), maxEstimatedVisualTokens: z.number().int().positive(),
  }).strict(),
}).strict();

export type ImageAsset = z.infer<typeof imageSchema>;
export type PhotoInput = z.infer<typeof photoInputSchema>;
export type PreparedComponent = z.infer<typeof componentSchema>;
export type SeparationResult = z.infer<typeof separationSchema>;
export type AnalysisScope = z.infer<typeof scopeSchema>;
export type InspectionBasis = z.infer<typeof basisSchema>;
export type ModelProfile = z.infer<typeof profileSchema>;
export type Layout = ModelProfile['layouts'][number];
export type Matrix3 = z.infer<typeof matrixSchema>;

export interface SheetPlacement { componentId: string; label: string; x: number; y: number; width: number; height: number }
export interface SheetPlan {
  width: number; height: number; labelHeight: number; placements: SheetPlacement[];
  // v1 排版只平移，不缩放裁片。实际生成器必须核对这些坐标和输出尺寸。
  scale: 1;
}
export interface PlannedBatch {
  protocol: typeof protocol; batchId: string; attemptId: string;
  scope: AnalysisScope; adapterId: string; profileId: string; profileVersion: string; mode: ModelProfile['mode'];
  basisSha256: string;
  layout: Layout; referenceImage: ImageAsset; components: PreparedComponent[];
  sheet: SheetPlan | null; estimatedVisualTokens: number; modelInputImageCount: number;
}
export interface ComposedSheet { batchId: string; image: ImageAsset; placements: SheetPlacement[] }
export interface RecognitionRequest {
  batch: PlannedBatch; basis: InspectionBasis;
  // 图片顺序固定：参考图由basis给出，然后是此数组。拼图时只有生成后的那一张。
  sampleImages: ImageAsset[];
}

const fields = {
  componentId: id, lines: z.array(z.string().max(512)).max(100),
  confidence: z.number().min(0).max(1).nullable(), reason: z.string().min(1).max(4000),
  features: z.array(z.string().max(2000)),
  differences: z.array(z.object({
    category: z.enum(['text', 'logo', 'shape', 'color', 'other']), message: z.string().min(1),
    lineIndex: z.number().int().nonnegative().nullable(), referenceText: z.string().nullable(), sampleText: z.string().nullable(),
  }).strict()),
};
export const modelReplySchema = z.object({
  items: z.array(z.discriminatedUnion('status', [
    z.object({ ...fields, status: z.literal('decided'), verdict: z.enum(['PASS', 'FAIL']) }).strict(),
    z.object({ ...fields, status: z.literal('unreadable'), verdict: z.null() }).strict(),
  ])),
  instructionConflicts: z.array(z.string()).default([]),
}).strict();
export type ModelReply = z.infer<typeof modelReplySchema>;
export const executionSchema = z.object({
  protocol: z.literal(protocol), batchId: id, attemptId: id, scope: scopeSchema,
  adapterId: id, modelId: id, profileId: id, profileVersion: id, mode: z.enum(['mock', 'real']),
  preprocessingVersion: id, elapsedMs: finite.nonnegative(), rawResponseAssetId: id,
  inputMetrics: z.array(z.object({
    inputIndex: z.number().int().nonnegative(), assetId: id,
    sentWidth: z.number().int().positive(), sentHeight: z.number().int().positive(),
    effectiveWidth: z.number().int().positive().nullable(), effectiveHeight: z.number().int().positive().nullable(),
  }).strict().refine(m => (m.effectiveWidth === null) === (m.effectiveHeight === null), '实际处理尺寸必须同时已知或同时为null')),
  reply: modelReplySchema,
}).strict();
export type RecognitionExecution = z.infer<typeof executionSchema>;
export interface AdapterContext { signal: AbortSignal }
export interface ComponentSeparator {
  separate(input: PhotoInput, context: AdapterContext): Promise<SeparationResult>;
}
export interface ComponentRouter {
  route(components: PreparedComponent[], scope: AnalysisScope, context: AdapterContext): Promise<{
    componentId: string; profileId: string; profileVersion: string; reason: string;
  }[]>;
}
export interface ContactSheetComposer {
  compose(batch: PlannedBatch, context: AdapterContext): Promise<ComposedSheet>;
}
export interface RecognitionAdapter {
  capabilities(): Promise<ModelProfile>;
  // 由具体运行时计算真实预算；不能把 API 的 prompt_tokens 一概视为完整视觉token。
  preflight(request: RecognitionRequest, context: AdapterContext): Promise<{
    accepted: boolean; reason: string; estimatedTotalInputTokens: number | null;
  }>;
  recognize(request: RecognitionRequest, context: AdapterContext): Promise<RecognitionExecution>;
}

export class VisionContractError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'VisionContractError'; this.code = code; }
}

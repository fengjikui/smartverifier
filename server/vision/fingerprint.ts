import { createHash } from 'node:crypto';
import { basisSchema } from './contracts.ts';
import type { InspectionBasis } from './contracts.ts';

/** 固定字段顺序，防止计划后替换标准说明、现场说明、提示词版本或参考图。 */
export function inspectionBasisDigest(input: InspectionBasis): string {
  const b = basisSchema.parse(input), r = b.referenceImage;
  return createHash('sha256').update(JSON.stringify([
    r.assetId, r.sha256, r.mime, r.width, r.height, r.bytes,
    b.standardDescription, b.onsiteInstruction, b.promptVersion, b.precedence,
  ])).digest('hex');
}

import type { Photo, SampleKind } from './types.ts';

/** 仅用于明确标记的本地预设流程样例，不是模型识别的真值规则。 */
export const twentySample = { count: 20, columns: 5, rows: 4, width: 2560, height: 1600 } as const;
export const twentyFailures = new Set([2, 7, 13, 18]);
const twentyLowConfidence = new Set([4, 10, 16]);
export function sampleCount(sample: SampleKind): number { return sample === 'twenty' ? 20 : sample === 'four' ? 4 : 1; }
export function sampleBox(sample: SampleKind, index: number): [number, number, number, number] {
  if (sample === 'twenty') return [index % 5 / 5, Math.floor(index / 5) / 4, 1 / 5, 1 / 4];
  return sample === 'four' ? [index % 2 / 2, Math.floor(index / 2) / 2, .5, .5] : [0,0,1,1];
}
export function sampleFails(sample: SampleKind, index: number): boolean { return sample === 'fail' || sample === 'four' && index === 2 || sample === 'twenty' && twentyFailures.has(index); }
export function sampleLowConfidence(sample: SampleKind, index: number): boolean { return sample === 'four' && index === 1 || sample === 'twenty' && twentyLowConfidence.has(index); }
/** 报告用：按object-fit:contain的同一坐标系标记，编号落在样例的留白内。 */
export function sampleMarker(photo: Photo, index: number) {
  const [x,y,w,h] = sampleBox(photo.sample!, index);
  return { x:(x + w * .025) * photo.width, y:(y + h * .025) * photo.height };
}

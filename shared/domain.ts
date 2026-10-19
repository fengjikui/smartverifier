import type { ComponentResult, Round, Summary, Verdict } from './types.ts';

export function finalVerdict(component: ComponentResult): Verdict | null {
  return component.review?.verdict ?? component.ai?.verdict ?? null;
}

export function summarize(round: Round): Summary {
  const components = round.photos.flatMap(photo => photo.components);
  const completed = components.filter(c => c.ai?.instructionVersion === round.instructionVersion && finalVerdict(c) !== null);
  const fail = completed.filter(c => finalVerdict(c) === 'FAIL').length;
  const unresolved = round.photos.some(p => p.status !== 'ready' || p.components.length === 0 || p.components.some(c => !c.ai || c.ai.instructionVersion !== round.instructionVersion));
  return {
    total: components.length, completed: completed.length, pass: completed.length - fail, fail,
    lowConfidence: completed.filter(c => c.ai!.confidence < .8 && !c.review).length,
    modified: completed.filter(c => c.review).length,
    pendingPhotos: round.photos.filter(p => ['pending', 'queued', 'running'].includes(p.status)).length,
    qualityPhotos: round.photos.filter(p => p.status === 'quality').length,
    failedPhotos: round.photos.filter(p => p.status === 'error').length,
    canSubmit: completed.length > 0 && !unresolved && !['queued', 'running', 'submitting', 'submitted', 'completed'].includes(round.status),
    verdict: completed.length > 0 && !unresolved ? (fail ? 'FAIL' : 'PASS') : null,
  };
}

export function assertMutable(round: Round) {
  if (['queued', 'running', 'submitting', 'submitted', 'completed'].includes(round.status)) throw new Error('当前轮次正在处理或已经提交，请等待完成或开始重新检测。');
}

export interface AlignedCharacter { expected: string | null; actual: string | null; different: boolean; expectedIndex: number | null; actualIndex: number | null }
export function alignText(expected: string, actual: string): AlignedCharacter[] {
  const a = Array.from(expected), b = Array.from(actual);
  // Bound the quadratic comparison; long passages are not marking codes.
  if (a.length > 512 || b.length > 512) throw new Error('单行丝印超过512字符，请分行展示。');
  const d = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]), d[i - 1][j] + 1, d[i][j - 1] + 1);
  let i = a.length, j = b.length;
  const output: AlignedCharacter[] = [];
  while (i || j) {
    let expectedIndex: number | null = null, actualIndex: number | null = null;
    if (i && j && d[i][j] === d[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1])) { expectedIndex = --i; actualIndex = --j; }
    else if (i && d[i][j] === d[i - 1][j] + 1) expectedIndex = --i;
    else actualIndex = --j;
    const x = expectedIndex === null ? null : a[expectedIndex], y = actualIndex === null ? null : b[actualIndex];
    output.push({ expected: x, actual: y, different: x !== y, expectedIndex, actualIndex });
  }
  return output.reverse();
}

/** 保留旧LM Studio记录的识别来源兼容性。 */
export function isVlmJudgement<T extends {source?:string}>(ai:T|null|undefined):ai is T{return ai?.source==='vlm'||ai?.source==='lmstudio';}
export function hasRealRecognition(status:{mode:string}|undefined){return status?.mode==='vlm'||status?.mode==='lmstudio';}

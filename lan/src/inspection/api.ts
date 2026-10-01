import { ApiError } from '../api';
export type Verdict = 'PASS' | 'FAIL' | 'REVIEW' | 'PENDING' | 'ERROR';
export type Person = { employee_id: string; name: string; identity_source: string };
export type Reference = { id: string; name: string; text: string; rules: string; version: number; image_url: string | null; synthetic_test: boolean };
export type Result = { verdict: Verdict; observed_text: string[]; features: string[]; summary: string; uncertainties: string[]; differences: { category: string; sample: string; reference: string; description: string }[] };
export type Component = { id: string; label: string; image_url: string; quality_flags: string[]; analysis: Result | null; error: string | null; final_verdict: Verdict; review: { verdict: Verdict; reason: string; operator: Person } | null; model_metadata?: { seconds: number; model: string } };
export type Photo = { id: string; label: string; preview_url: string; original_url: string; annotation_url: string; flags: string[]; components: Component[] };
export type Summary = { expected_count: number; sample_count: number; photo_count: number; pass_count: number; fail_count: number; review_count: number; pending_count: number; error_count: number; verdict: 'PASS' | 'FAIL' | 'INCOMPLETE'; can_submit: boolean; blocking_flags: string[] };
export type Task = { id: string; number: string; material: string; item_id: string; expected_count: number; capture_mode: 'single' | 'multi'; auto_writeback: boolean; inspector: Person; reference: Reference; photos: Photo[]; revision: number; updated: number; synthetic_test: boolean; summary: Summary; run: { status: string; model?: string; current?: string; error?: string; ahead?: number; queued_at?: number; started?: number; finished?: number }; transfer?: { key: string; status: string; error?: string; mode: string; attempts: number; receipt?: { receipt_id: string; saved_at: number; final_submission: boolean } } };
export type TaskRow = Pick<Task, 'id' | 'number' | 'material' | 'expected_count' | 'updated' | 'summary' | 'run' | 'transfer' | 'synthetic_test'>;
export type Bootstrap = { profile: Person | null; references: Reference[]; tasks: TaskRow[]; models: { id: string; name: string; available: boolean }[]; mes_mode: string };
export async function request<T>(path: string, body?: object | FormData, method = 'POST'): Promise<T> {
  const response = await fetch('/api/inspection' + path, { credentials: 'same-origin',
    ...(body === undefined ? {} : { method, headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' }, body: body instanceof FormData ? body : JSON.stringify(body) }) });
  const data: unknown = await response.json().catch(() => ({}));
  const detail = data && typeof data === 'object' && 'detail' in data ? data.detail : undefined;
  if (!response.ok) throw new ApiError(response.status, typeof detail === 'string' ? detail : '信息格式不正确，或服务暂不可用。请检查后重试。');
  return data as T;
}
export function stateLabel(t: TaskRow) {
  if (t.transfer?.status === 'saved') return t.transfer.mode === 'mock' ? '模拟已回填' : '已回填';
  if (t.transfer?.status === 'sending') return '正在回填';
  if (t.transfer?.status === 'failed') return '回填待重试';
  if (t.run.status === 'queued') return '排队中';
  if (t.run.status === 'running') return '正在识别';
  if (t.summary.review_count || t.summary.error_count) return '需要复核';
  if (t.summary.can_submit) return '可回填';
  return '待继续';
}
export const verdictLabel: Record<Verdict, string> = { PASS: '通过', FAIL: '不合格', REVIEW: '待复核', PENDING: '待识别', ERROR: '识别未完成' };

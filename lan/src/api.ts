export type Viewport = { mode: "whole" | "crop"; aspect: "1:1" | "4:3" | "3:4" | "free"; aspect_ratio?: number; zoom: number; rotation: number; pan_x: number; pan_y: number };
export const defaultViewport: Viewport = { mode: "whole", aspect: "1:1", zoom: 1, rotation: 0, pan_x: 0, pan_y: 0 };
export type Photo = { id: string; name: string; width: number; height: number; preview_url: string };
export type View = { id: string; image_id: string; url: string; mode: "whole" | "crop"; width: number; height: number; settings: Viewport; source_coverage?: number };
export type Model = { id: string; name: string; size: string; available: boolean; note: string };
export type Message = { id: string; role: "user" | "assistant"; text: string; status: string; view_id?: string; model?: string; seconds?: number; partial?: boolean };
export type Chat = { id: string; title: string; messages: Message[]; active_job: string | null; current_view?: string; view?: View; image?: Photo };
export type ChatSummary = { id: string; title: string; updated: number; active_job?: string };
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function api<T>(path: string, body?: object | FormData): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", ...(body === undefined ? {} : {
    method: "POST", headers: body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body),
  }) });
  const result: unknown = await response.json().catch(() => ({}));
  const detail = result && typeof result === "object" && "detail" in result ? result.detail : undefined;
  if (!response.ok) throw new ApiError(response.status, typeof detail === "string" ? detail : "操作没有完成，请稍后重试。");
  return result as T;
}
export function requestId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""); }

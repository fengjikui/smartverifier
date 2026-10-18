export type Verdict = 'PASS' | 'FAIL';
export type PhotoStatus = 'pending' | 'queued' | 'running' | 'ready' | 'quality' | 'error';
export type RoundStatus = 'draft' | 'queued' | 'running' | 'ready' | 'submitting' | 'submitted' | 'submit_failed' | 'completed';
export type SampleKind = 'pass' | 'fail' | 'four' | 'twenty' | 'quality';
export interface Person { id: string; name: string }
export interface Review { id: string; verdict: Verdict; reason: string; person: Person; at: string; instructionVersion: number }
export interface AIJudgement { verdict: Verdict; lines: string[]; confidence: number; reason: string; instructionVersion: number;
  source?: 'vlm'|'lmstudio'; provider?:'lmstudio'|'openai-compatible'; model?: string; elapsedMs?: number; promptVersion?: string; rawRecord?: string;
  features?: string[]; differences?: { category:string; message:string; lineIndex:number|null; referenceText:string|null; sampleText:string|null }[]; instructionConflicts?: string[]; instructionWarnings?:string[];
}
export interface ComponentResult {
  id: string; label: string; index: number; bbox: [number, number, number, number];
  ai: AIJudgement | null; aiHistory: AIJudgement[];
  review: Review | null; reviewHistory: Review[];
  crop?: { url: string; width: number; height: number; rotation: number; qualityReasons: string[]; assetId: string };
}
export interface Preparation { version:string; sourceHash:string; uprightUrl:string; annotatedUrl:string; sheetUrl:string; width:number; height:number; elapsedMs:number; coverage:'complete'|'uncertain'; issues:string[] }
export interface Photo {
  id: string; sequence: number; filename: string; file: string; url: string; hash: string;
  width: number; height: number; sample: SampleKind | null; status: PhotoStatus; uploadKey?: string;
  message: string; components: ComponentResult[];
  preparation?: Preparation;
}
export interface Standard { id: string; version: number; material: string; supplier: string; image: string; lines: string[]; description: string }
export interface Transfer { id: string; key: string; revision: number; status: 'sending' | 'success' | 'failed'; message: string; at: string; receipt?: string; reportUrl?: string }
export interface Round {
  id: string; taskId: string; number: number; revision: number; status: RoundStatus; createdAt: string;
  standard: Standard; instruction: string; instructionVersion: number; nextPhotoSequence: number; photos: Photo[];
  transfer: Transfer | null; submittedBy?: Person; completedBy?:Person; completedAt?:string;
}
export interface Task {
  id: string; number: string; material: string; supplier: string; standard: Standard | null;
  roundId: string | null; effectiveRoundId: string | null;
  origin?: 'local'|'mes'|'demo'|'demo-mes'|'standalone';
  referenceId?:string; ownerId?:string; clientId?:string; createdAt?:string;
  trialPhoto?: 'single'|'pair'|'dim-three';
}
export interface Summary {
  total: number; completed: number; pass: number; fail: number; lowConfidence: number; modified: number;
  pendingPhotos: number; qualityPhotos: number; failedPhotos: number; canSubmit: boolean; verdict: Verdict | null;
}
export interface TaskListItem extends Task { status: string; summary: Summary | null }
export interface TaskView { task: Task; round: Round | null; effective: Round | null; summary: Summary | null }
export interface RecognitionStatus { mode:'mock'|'vlm'|'lmstudio'; model?:string;provider?:'lmstudio'|'openai-compatible' }
export interface Bootstrap { person: Person; mode: 'mock'; recognition?:RecognitionStatus; tasks: TaskListItem[] }

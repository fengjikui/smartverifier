import type { Person, Standard } from './types.ts';
export interface ReferenceAsset { id:string; filename:string; width:number; height:number; bytes:number; sha256:string; thumbnail:string; originalId?:string; analysisId?:string }
export interface ReferenceRegion { id:string; kind:'ignore'|'focus'; x:number; y:number; width:number; height:number; label:string }
export interface ReferenceAnalysisResult { confidence?:number; quality:'clear'|'poor'|'uncertain'; qualityReason:string; lines:string[]; ambiguities:{text:string;reason:string}[]; description:string; component:{x:number;y:number;width:number;height:number;angle:number}|null; regionReadings:{id:string;text:string|null;readable:boolean}[] }
export interface ReferenceAnalysis { id:string; assetId:string; key:string; regions:ReferenceRegion[]; state:'queued'|'running'|'completed'|'failed'; stage:string; message:string; createdAt:string; finishedAt?:string; model:string; result?:ReferenceAnalysisResult; elapsedMs?:number }
export interface ReferenceRecord extends Standard {
  name:string; status:'active'|'draft'; assetId:string; asset:ReferenceAsset|null;
  createdAt:string; updatedAt:string; updatedBy:Person; deletedAt:string|null; analysisId?:string; analysis?:ReferenceAnalysis; reviewReason?:string; manualApproval?:{kind:'confirmed'|'override';reason:string;actor:Person;at:string}; needsRemark?:boolean;
}
export interface ReferenceInput { material:string; supplier:string; modelNumber?:string; name:string; description:string; lines:string[]; assetId:string; status:'active'|'draft'; regions?:ReferenceRegion[]; analysisId?:string; reviewReason?:string }
export interface Page<T> { items:T[]; total:number; page:number; size:number }
export type AdminRole='owner'|'standard_admin';
export type AdminAccountStatus='active'|'disabled';
export interface AdminSession { person:Person; mode:'local'|'password'; localOnly:boolean; role:AdminRole }
export interface AdminLoginConfig { accessMode:'trial'|'password'; localOnly:boolean }
export interface AdminAccount {
  id:string;name:string;role:AdminRole;status:AdminAccountStatus;version:number;
  source:'server'|'managed';createdAt:string;updatedAt:string;lastLoginAt:string|null;
}
export type AccountSummary=Pick<AdminAccount,'id'|'name'|'role'|'status'>;
export interface AccessEvent {
  id:number;at:string;actor:Person;accountId:string;action:string;reason:string;
  before:AccountSummary|null;after:AccountSummary|null;
}
export interface MaintenanceEvent { id:number; entity:string; action:string; actor:Person; at:string; before:unknown; after:unknown }
export interface ReferenceDetail { record:ReferenceRecord; events:MaintenanceEvent[] }
export interface ImportRow { row:number; material:string; supplier:string; modelNumber?:string; name:string; description:string; lines:string[]; imagePath:string; assetId?:string; status:'ready'|'skip'|'error'; message:string; decision?:'include'|'defer'; duplicateId?:string; duplicateVersion?:number; batchGroup?:string; savedId?:string; regions?:ReferenceRegion[]; analysisId?:string; analysis?:ReferenceAnalysis; reviewReason?:string; needsRemark?:boolean; manualContent?:boolean }
export interface ImportJob { id:string; version?:number; status:'validating'|'preview'|'failed'|'committed'; filename:string; rows:ImportRow[]; message:string; counts:{ready:number;skip:number;error:number}; receipt?:{created:number;updated?:number;skipped:number}; createdAt:string }

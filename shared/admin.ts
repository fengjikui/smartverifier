import type { Person, Standard, Task } from './types.ts';
export interface ReferenceAsset { id:string; filename:string; width:number; height:number; bytes:number; sha256:string; thumbnail:string }
export interface ReferenceRecord extends Standard {
  name:string; status:'active'|'draft'; assetId:string; asset:ReferenceAsset|null;
  createdAt:string; updatedAt:string; updatedBy:Person; deletedAt:string|null;
}
export interface ReferenceInput { material:string; supplier:string; modelNumber?:string; name:string; description:string; lines:string[]; assetId:string; status:'active'|'draft' }
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
export interface ReferenceDetail { record:ReferenceRecord; events:MaintenanceEvent[]; tasks:Task[] }
export interface ImportRow { row:number; material:string; supplier:string; modelNumber?:string; name:string; description:string; lines:string[]; imagePath:string; assetId?:string; status:'ready'|'skip'|'error'; message:string }
export interface ImportJob { id:string; status:'validating'|'preview'|'failed'|'committed'; filename:string; rows:ImportRow[]; message:string; counts:{ready:number;skip:number;error:number}; receipt?:{created:number;skipped:number}; createdAt:string }

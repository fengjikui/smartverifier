import type { Standard, TaskListItem } from './types.ts';
export interface CatalogChoice extends Standard { name:string; thumbnail:string }
export interface CatalogPage { items:CatalogChoice[]; total:number; page:number; size:number; suppliers:string[] }
export interface TaskPage { items:TaskListItem[]; total:number; page:number; size:number }

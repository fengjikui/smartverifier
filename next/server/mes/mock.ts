import { createHash } from 'node:crypto';
import type { Standard, Task } from '../../shared/types.ts';
/** 临时 MES 模拟源：按正品身份生成可重复的任务，不接触任何外部系统。 */
export function mockTask(standard:Standard):Task {
  const identity=createHash('sha256').update(JSON.stringify([standard.material,standard.supplier])).digest('hex').slice(0,12).toUpperCase();
  return {id:'SIMMES'+standard.id.replaceAll('-','').toUpperCase()+identity,number:'模拟MES · '+standard.material,material:standard.material,supplier:standard.supplier,standard,origin:'demo-mes',referenceId:standard.id,roundId:null,effectiveRoundId:null};
}
export function mockReferenceId(taskId:string){
  const match=taskId.match(/^SIMMES([A-F0-9]{32})[A-F0-9]{12}$/);if(!match)return null;
  const v=match[1].toLowerCase();return [v.slice(0,8),v.slice(8,12),v.slice(12,16),v.slice(16,20),v.slice(20)].join('-');
}

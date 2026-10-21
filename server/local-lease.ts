/** 本机进程租约；只释放自己的锁，遗留锁仅在原 PID 已退出后回收。 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type Lease={pid:number;nonce:string;root:string;createdAt:string};
export function processAlive(pid:number):boolean {
  try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}
export function assertLeaseFree(filename:string){
  try{if(lstatSync(filename).isSymbolicLink())throw new Error('锁路径不能是符号链接：'+filename);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  let lease:Lease;
  try{lease=JSON.parse(readFileSync(path.join(filename,'owner.json'),'utf8'));if(!Number.isInteger(lease.pid)||lease.pid<=0||!lease.nonce)throw new Error();}
  catch{throw new Error('进程锁信息不完整，请确认没有服务或更新进程运行，再手工检查：'+filename);}
  if(processAlive(lease.pid))throw new Error(`检测到服务或更新仍在运行（PID ${lease.pid}）。请先正常停止，再重试。`);
  rmSync(filename,{recursive:true});
}
export function acquireLease(filename:string,root:string){
  mkdirSync(path.dirname(filename),{recursive:true});assertLeaseFree(filename);
  try{mkdirSync(filename,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('另一个进程正在启动或更新，请稍后重试。');throw error;}
  const lease:Lease={pid:process.pid,nonce:randomUUID(),root,createdAt:new Date().toISOString()};
  try{writeFileSync(path.join(filename,'owner.json'),JSON.stringify(lease),{mode:0o600,flag:'wx'});}catch(error){rmSync(filename,{recursive:true});throw error;}
  return ()=>{try{const current=JSON.parse(readFileSync(path.join(filename,'owner.json'),'utf8'));if(current.nonce===lease.nonce)rmSync(filename,{recursive:true});}catch{/* 不删除其他进程的锁。 */}};
}
export const updateLeasePath=(root:string)=>path.join(root,'var','.update-lock');
export const stateUpdateLeasePath=(state:string)=>path.join(state,'.update-lock');
export const serviceLeasePath=(state:string)=>path.join(state,'.service-lock');

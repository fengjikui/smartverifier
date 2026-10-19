import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const adminUsersSchema=z.array(z.object({
  id:z.string().min(1).max(80).regex(/^[A-Za-z0-9_.@-]+$/),
  name:z.string().trim().min(1).max(80),
  salt:z.string().min(16).max(256),
  hash:z.string().regex(/^[a-f0-9]{64}$/i),
  role:z.enum(['owner','standard_admin']).optional(),
}).strict()).min(1).max(100).superRefine((users,ctx)=>{
  if(new Set(users.map(u=>u.id)).size!==users.length)ctx.addIssue({code:'custom',message:'管理员账号不能重复。'});
});
export type AdminUser=z.infer<typeof adminUsersSchema>[number];
export type AdminAccessConfig={localOnly:boolean;users:AdminUser[]|null};
export function adminLocalOnly(value:string|undefined):boolean {
  if(value===undefined||value.trim()==='')return true;
  if(['1','true'].includes(value.trim().toLowerCase()))return true;
  if(['0','false'].includes(value.trim().toLowerCase()))return false;
  throw new Error('SV_ADMIN_LOCAL_ONLY 只能填 true / false 或 1 / 0。');
}
export function readAdminAccess(env:NodeJS.ProcessEnv=process.env,root=process.cwd()):AdminAccessConfig {
  const localOnly=adminLocalOnly(env.SV_ADMIN_LOCAL_ONLY),filename=env.SV_ADMIN_USERS_FILE?.trim();
  let users:AdminUser[]|null=null;
  if(filename){
    try{users=adminUsersSchema.parse(JSON.parse(readFileSync(path.resolve(root,filename),'utf8')));}
    catch{throw new Error('管理员账号文件无法读取或格式不正确，请检查或恢复配置文件；首次初始化运行 npm run admin:owner。');}
  }
  if(!localOnly&&!users)throw new Error('开放管理员远程访问前，请先运行 npm run admin:account 设置独立账号密码；不允许远程使用默认试用账号。');
  return {localOnly,users};
}
/** A password, account or identity change invalidates its existing sessions. */
export const adminCredential=(user:AdminUser)=>createHash('sha256').update(JSON.stringify(user)).digest('hex');

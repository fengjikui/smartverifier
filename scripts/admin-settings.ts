import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { adminLocalOnly, adminUsersSchema, readAdminAccess } from '../server/admin/access-config.ts';

export function localAdminEnvironment(root:string){
  const filename=path.join(root,'.env.local');
  return {...(existsSync(filename)?parseEnv(readFileSync(filename,'utf8')):{}),...process.env};
}
function privateWrite(filename:string,content:string){
  mkdirSync(path.dirname(filename),{recursive:true});
  const temporary=filename+'.'+randomBytes(6).toString('hex')+'.tmp';
  writeFileSync(temporary,content,{mode:0o600,flag:'wx'});renameSync(temporary,filename);chmodSync(filename,0o600);
}
export function updateLocalEnvironment(root:string,values:Record<string,string>){
  const filename=path.join(root,'.env.local'),source=existsSync(filename)?readFileSync(filename,'utf8'):'',seen=new Set<string>();
  const lines=source.split(/\r?\n/).flatMap(line=>{
    const key=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if(!key||!(key in values))return [line];
    if(seen.has(key))return [];seen.add(key);return [key+'='+values[key]];
  });
  for(const [key,value] of Object.entries(values))if(!seen.has(key))lines.push(key+'='+value);
  privateWrite(filename,lines.join('\n').replace(/\n*$/,'\n'));
}
export function configureAdminAccount(root:string,input:{id:string;name:string;password:string},replace=false){
  if(input.password.trim().length<12||input.password.length>256)throw new Error('密码须为12–256个字符，请使用自己设置的密码。');
  const env=localAdminEnvironment(root),setting=env.SV_ADMIN_USERS_FILE?.trim()||'./var/config/admin-users.json',filename=path.resolve(root,setting);
  adminLocalOnly(env.SV_ADMIN_LOCAL_ONLY);
  const user={id:input.id.trim(),name:input.name.trim(),salt:randomBytes(24).toString('hex'),hash:''};
  user.hash=scryptSync(input.password,user.salt,32).toString('hex');
  adminUsersSchema.parse([user]);
  const users=existsSync(filename)?adminUsersSchema.parse(JSON.parse(readFileSync(filename,'utf8'))):[],index=users.findIndex(u=>u.id===user.id);
  if(index>=0&&!replace)throw new Error('账号已存在。若要更新密码或姓名，请运行 npm run admin:account -- --replace。');
  if(index>=0)users[index]=user;else users.push(user);
  privateWrite(filename,JSON.stringify(adminUsersSchema.parse(users),null,2)+'\n');
  const values:Record<string,string>={SV_ADMIN_USERS_FILE:JSON.stringify(setting.replaceAll('\\','/'))};
  if(env.SV_ADMIN_LOCAL_ONLY===undefined)values.SV_ADMIN_LOCAL_ONLY='true';
  updateLocalEnvironment(root,values);
  return {id:user.id,name:user.name,filename,localOnly:readAdminAccess(localAdminEnvironment(root),root).localOnly};
}
export function configureAdminAccess(root:string,scope:'local'|'lan'){
  const env=localAdminEnvironment(root),value=scope==='local'?'true':'false';
  // Validate before changing the file, including the requirement for named accounts.
  const config=readAdminAccess({...env,SV_ADMIN_LOCAL_ONLY:value},root);
  updateLocalEnvironment(root,{SV_ADMIN_LOCAL_ONLY:value});return config;
}

import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store.ts';
import type { Person } from '../../shared/types.ts';
import { ApiError } from '../errors.ts';
import { directLoopback as local } from '../network.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const cookie=(req:IncomingMessage)=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('sv_admin_session='))?.slice(17);
export class AdminAuth {
  store:Store; attempts=new Map<string,{count:number;until:number}>();
  constructor(store:Store){this.store=store;store.db.exec('CREATE TABLE IF NOT EXISTS admin_sessions(token TEXT PRIMARY KEY,person TEXT NOT NULL,expires INTEGER NOT NULL,local_only INTEGER NOT NULL)');}
  current(req:IncomingMessage){const token=cookie(req);if(!token)return null;const row=this.store.db.prepare('SELECT * FROM admin_sessions WHERE token=?').get(hash(token));if(!row||Number(row.expires)<Date.now()||row.local_only&&!local(req))return null;return {person:JSON.parse(String(row.person)) as Person,mode:'local' as const,localOnly:!!row.local_only};}
  require(req:IncomingMessage){const s=this.current(req);if(!s)throw new ApiError(401,'请登录正品管理工作台。录入内容已保留。');return s.person;}
  login(req:IncomingMessage,res:ServerResponse,input:{id?:string;name?:string;code?:string}){
    const address=req.socket.remoteAddress??'',now=Date.now(),attempt=this.attempts.get(address);
    if(attempt&&attempt.until>now&&attempt.count>=8)throw new ApiError(429,'尝试次数过多，请在 10 分钟后重试。');
    let person:Person,localOnly=true;
    const config=process.env.SV_ADMIN_USERS_FILE;
    if(config){
      const users=JSON.parse(readFileSync(config,'utf8')) as {id:string;name:string;salt:string;hash:string}[];
      const user=users.find(u=>u.id===input.id),valid=!!user&&!!input.code&&input.code.length<=256&&timingSafeEqual(scryptSync(input.code,user.salt,32),Buffer.from(user.hash,'hex'));
      if(!valid){if(this.attempts.size>10000)this.attempts.clear();this.attempts.set(address,{count:attempt&&attempt.until>now?attempt.count+1:1,until:now+600000});throw new ApiError(401,'账号或密码不正确。');}
      person={id:user.id,name:user.name};localOnly=false;
    }else{
      if(!local(req))throw new ApiError(403,'尚未接入 IDaaS，试用管理员仅允许在服务器本机登录。');
      if(input.id!=='admin'||input.code!=='admin123')throw new ApiError(401,'请使用页面提示的试用账号和密码。');
      person={id:'ADMIN-TRIAL',name:'试用管理员'};
    }
    this.attempts.delete(address);const token=randomBytes(32).toString('hex');this.store.db.prepare('DELETE FROM admin_sessions WHERE expires<?').run(now);this.store.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?,?)').run(hash(token),JSON.stringify(person),now+8*3600000,localOnly?1:0);
    res.setHeader('Set-Cookie',`sv_admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${('encrypted' in req.socket&&req.socket.encrypted)?'; Secure':''}`);
    return {person,mode:'local' as const,localOnly};
  }
  logout(req:IncomingMessage,res:ServerResponse){const t=cookie(req);if(t)this.store.db.prepare('DELETE FROM admin_sessions WHERE token=?').run(hash(t));res.setHeader('Set-Cookie','sv_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');}
}

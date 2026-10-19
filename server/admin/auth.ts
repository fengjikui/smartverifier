import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store.ts';
import type { Person } from '../../shared/types.ts';
import type { AdminSession } from '../../shared/admin.ts';
import { ApiError } from '../errors.ts';
import { directLoopback as local } from '../network.ts';
import { adminCredential, readAdminAccess } from './access-config.ts';
import type { AdminAccessConfig } from './access-config.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),derive=promisify(scrypt);
const cookie=(req:IncomingMessage)=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('sv_admin_session='))?.slice(17);
export class AdminAuth {
  store:Store;config:AdminAccessConfig;attempts=new Map<string,{count:number;until:number}>();
  constructor(store:Store,config=readAdminAccess()){
    if(!config.localOnly&&!config.users?.length)throw new Error('远程正品管理必须配置独立账号密码。');
    this.store=store;this.config=config;
    store.db.exec("CREATE TABLE IF NOT EXISTS admin_sessions(token TEXT PRIMARY KEY,person TEXT NOT NULL,expires INTEGER NOT NULL,local_only INTEGER NOT NULL,credential TEXT NOT NULL DEFAULT '')");
    if(!store.db.prepare('PRAGMA table_info(admin_sessions)').all().some(column=>column.name==='credential'))store.db.exec("ALTER TABLE admin_sessions ADD COLUMN credential TEXT NOT NULL DEFAULT ''");
  }
  publicConfig(){return {accessMode:this.config.users?'password' as const:'trial' as const,localOnly:this.config.localOnly};}
  current(req:IncomingMessage):AdminSession|null {
    // Recheck the current server policy even for a previously issued remote session.
    if(this.config.localOnly&&!local(req))return null;
    const token=cookie(req);if(!token)return null;
    const row=this.store.db.prepare('SELECT * FROM admin_sessions WHERE token=?').get(hash(token));
    if(!row||Number(row.expires)<Date.now()||row.local_only&&!local(req))return null;
    let person=JSON.parse(String(row.person)) as Person;
    if(this.config.users){
      const user=this.config.users.find(u=>u.id===person.id);
      if(!user||row.credential!==adminCredential(user))return null;
      person={id:user.id,name:user.name};
    }else if(person.id!=='ADMIN-TRIAL'||row.credential!=='')return null;
    return {person,mode:this.config.users?'password':'local',localOnly:this.config.localOnly||!!row.local_only};
  }
  require(req:IncomingMessage){const s=this.current(req);if(!s)throw new ApiError(401,'请登录正品管理工作台。录入内容已保留。');return s.person;}
  async login(req:IncomingMessage,res:ServerResponse,input:{id?:string;name?:string;code?:string}):Promise<AdminSession>{
    if(this.config.localOnly&&!local(req))throw new ApiError(403,'当前正品管理仅允许服务器本机访问，请联系部署人员开放局域网访问。');
    const address=req.socket.remoteAddress??'',now=Date.now(),attempt=this.attempts.get(address);
    if(attempt&&attempt.until>now&&attempt.count>=8)throw new ApiError(429,'尝试次数过多，请在 10 分钟后重试。');
    for(const [ip,value] of this.attempts)if(value.until<=now)this.attempts.delete(ip);
    if(this.attempts.size>=10000&&!this.attempts.has(address))throw new ApiError(429,'登录请求过多，请稍后重试。');
    // Reserve before async password verification so concurrent failures cannot bypass the limit.
    const reservation={count:attempt&&attempt.until>now?attempt.count+1:1,until:now+600000};this.attempts.set(address,reservation);
    let person:Person,credential='';
    if(this.config.users){
      const user=this.config.users.find(u=>u.id===input.id?.trim()),code=input.code??'';
      const derived=await derive(code.length<=256?code:'',user?.salt??'unknown-account-salt',32) as Buffer;
      if(!user||!code||code.length>256||!timingSafeEqual(derived,Buffer.from(user.hash,'hex')))throw new ApiError(401,'账号或密码不正确。');
      person={id:user.id,name:user.name};credential=adminCredential(user);
    }else{
      if(input.id!=='admin'||input.code!=='admin123')throw new ApiError(401,'账号或密码不正确。');
      person={id:'ADMIN-TRIAL',name:'试用管理员'};
    }
    if(this.attempts.get(address)===reservation)this.attempts.delete(address);
    const token=randomBytes(32).toString('hex');this.store.db.prepare('DELETE FROM admin_sessions WHERE expires<?').run(now);
    this.store.db.prepare('INSERT INTO admin_sessions(token,person,expires,local_only,credential) VALUES(?,?,?,?,?)').run(hash(token),JSON.stringify(person),Date.now()+8*3600000,this.config.localOnly?1:0,credential);
    res.setHeader('Set-Cookie',`sv_admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${('encrypted' in req.socket&&req.socket.encrypted)?'; Secure':''}`);
    return {person,mode:this.config.users?'password':'local',localOnly:this.config.localOnly};
  }
  logout(req:IncomingMessage,res:ServerResponse){const t=cookie(req);if(t)this.store.db.prepare('DELETE FROM admin_sessions WHERE token=?').run(hash(t));res.setHeader('Set-Cookie','sv_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');}
}

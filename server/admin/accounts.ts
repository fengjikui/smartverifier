import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store.ts';
import type { Person } from '../../shared/types.ts';
import type { AccountSummary, AdminAccount, AdminAccountStatus, AccessEvent, Page } from '../../shared/admin.ts';
import type { AdminUser } from './access-config.ts';
import { adminCredential } from './access-config.ts';
import { accountPassword, newPassword } from './password.ts';
import { ApiError } from '../errors.ts';

type AccountRecord=AdminAccount&{salt:string;hash:string;seed:string|null};
type Authorize=()=>Person;
export const accountId=z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.@-]+$/).refine(value=>!['.','..','ADMIN-TRIAL','SERVER-CONFIG'].includes(value),'请使用非系统保留账号。');
export const accountName=z.string().trim().min(1).max(80);
export const createAccount=z.object({id:accountId,name:accountName,password:accountPassword}).strict();
const stamp=()=>new Date().toISOString(),deployment:Person={id:'SERVER-CONFIG',name:'服务器配置'};
const summary=(a:AccountRecord):AccountSummary=>({id:a.id,name:a.name,role:a.role,status:a.status});
export const accountCredential=(a:AccountRecord)=>createHash('sha256').update(JSON.stringify([a.id,a.name,a.role,a.status,a.salt,a.hash,a.version])).digest('hex');
export function publicAccount(a:AccountRecord):AdminAccount {
  const {salt:_salt,hash:_hash,seed:_seed,...result}=a;return result;
}
export class AdminAccounts {
  readonly store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS admin_accounts(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_access_events(id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,before_data TEXT,after_data TEXT,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS admin_access_target ON admin_access_events(account_id,id DESC);`);
  }
  get(id:string):AccountRecord|null {const row=this.store.db.prepare('SELECT data FROM admin_accounts WHERE id=?').get(id);return row?JSON.parse(String(row.data)):null;}
  all():AccountRecord[]{return this.store.db.prepare('SELECT data FROM admin_accounts ORDER BY id').all().map(row=>JSON.parse(String(row.data)));}
  count(){return Number(this.store.db.prepare('SELECT COUNT(*) n FROM admin_accounts').get()!.n);}
  private persist(account:AccountRecord){this.store.db.prepare('INSERT INTO admin_accounts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(account.id,JSON.stringify(account));}
  private revoke(id:string){
    // Do not depend on JSON text formatting of the stored person.
    this.store.db.prepare("DELETE FROM admin_sessions WHERE json_extract(person,'$.id')=?").run(id);
  }
  private event(action:string,id:string,actor:Person,before:AccountRecord|null,after:AccountRecord|null,reason:string){
    this.store.db.prepare('INSERT INTO admin_access_events(account_id,actor,action,reason,before_data,after_data,at) VALUES(?,?,?,?,?,?,?)').run(id,JSON.stringify(actor),action,reason,before?JSON.stringify(summary(before)):null,after?JSON.stringify(summary(after)):null,stamp());
  }
  /** Config is the offline recovery authority. Unchanged seeds never undo a web suspension/reset. */
  seed(users:AdminUser[]){
    this.store.transaction(()=>{
      const ids=new Set(users.map(user=>user.id));
      for(const user of users){
        const before=this.get(user.id),fingerprint=adminCredential(user);if(before?.source==='server'&&before.seed===fingerprint&&(before.role!=='owner'||before.status==='active'))continue;
        const at=stamp(),after:AccountRecord={id:user.id,name:user.name,role:user.role??'standard_admin',status:user.role==='owner'||!before?'active':before.status,salt:user.salt,hash:user.hash,version:(before?.version??0)+1,source:'server',seed:fingerprint,createdAt:before?.createdAt??at,updatedAt:at,lastLoginAt:before?.lastLoginAt??null};
        this.persist(after);this.revoke(after.id);this.event(before?'account.server-update':'account.server-create',after.id,deployment,before,after,'由服务器账号配置导入或恢复');
      }
      for(const before of this.all())if(before.source==='server'&&!ids.has(before.id)&&before.status==='active'){
        const after={...before,status:'disabled' as const,version:before.version+1,updatedAt:stamp()};this.persist(after);this.revoke(before.id);this.event('account.server-remove',before.id,deployment,before,after,'已从服务器账号配置中移除');
      }
    });
  }
  page(q='',status='all',page=1,size=25):Page<AdminAccount>{
    const keyword=q.toLowerCase(),items=this.all().filter(a=>(status==='all'||a.status===status)&&(!keyword||(a.id+' '+a.name).toLowerCase().includes(keyword))).sort((a,b)=>Number(b.role==='owner')-Number(a.role==='owner')||a.id.localeCompare(b.id));
    return {items:items.slice((page-1)*size,page*size).map(publicAccount),total:items.length,page,size};
  }
  events(q='',page=1,size=25):Page<AccessEvent>{
    const params=q?['%'+q.replace(/[!%_]/g,c=>'!'+c)+'%']:[],where=q?"(account_id LIKE ? ESCAPE '!' OR actor LIKE ? ESCAPE '!' OR reason LIKE ? ESCAPE '!')":'1=1',search=q?[...params,...params,...params]:[];
    const rows=this.store.db.prepare('SELECT * FROM admin_access_events WHERE '+where+' ORDER BY id DESC LIMIT ? OFFSET ?').all(...search,size,(page-1)*size);
    return {items:rows.map(row=>({id:Number(row.id),at:String(row.at),accountId:String(row.account_id),actor:JSON.parse(String(row.actor)),action:String(row.action),reason:String(row.reason),before:row.before_data?JSON.parse(String(row.before_data)):null,after:row.after_data?JSON.parse(String(row.after_data)):null})),total:Number(this.store.db.prepare('SELECT COUNT(*) n FROM admin_access_events WHERE '+where).get(...search)!.n),page,size};
  }
  async create(raw:unknown,authorize:Authorize){
    const input=createAccount.parse(raw),password=await newPassword(input.password);
    return this.store.transaction(()=>{
      const actor=authorize();if(this.get(input.id))throw new ApiError(409,'账号已存在，包括已停用账号。请搜索原账号并启用，历史账号不能重复分配。');
      const at=stamp(),account:AccountRecord={id:input.id,name:input.name,role:'standard_admin',status:'active',version:1,source:'managed',seed:null,createdAt:at,updatedAt:at,lastLoginAt:null,...password};
      this.persist(account);this.event('account.create',account.id,actor,null,account,'新增正品管理员');return publicAccount(account);
    });
  }
  private editable(id:string,version:number){
    const account=this.get(id);if(!account)throw new ApiError(404,'账号不存在。');
    if(account.role==='owner')throw new ApiError(403,'系统负责人账号只能由服务器端配置，不能在网页停用或修改。');
    if(account.version!==version)throw new ApiError(409,'账号已被其他负责人修改，请刷新后重试。');return account;
  }
  status(id:string,version:number,status:AdminAccountStatus,reason:string,authorize:Authorize){
    return this.store.transaction(()=>{
      const actor=authorize(),before=this.editable(id,version);if(before.status===status)return publicAccount(before);
      const after={...before,status,version:before.version+1,updatedAt:stamp()};this.persist(after);this.revoke(id);this.event(status==='disabled'?'account.disable':'account.enable',id,actor,before,after,reason);return publicAccount(after);
    });
  }
  rename(id:string,version:number,name:string,authorize:Authorize){
    return this.store.transaction(()=>{
      const actor=authorize(),before=this.editable(id,version),after={...before,name:accountName.parse(name),version:before.version+1,updatedAt:stamp()};
      this.persist(after);this.revoke(id);this.event('account.rename',id,actor,before,after,'修改显示姓名');return publicAccount(after);
    });
  }
  async resetPassword(id:string,version:number,password:string,authorize:Authorize){
    // Check the target before hashing, and check it again inside the atomic change.
    this.editable(id,version);const credential=await newPassword(password);
    return this.store.transaction(()=>{
      const actor=authorize(),before=this.editable(id,version),after={...before,...credential,version:before.version+1,updatedAt:stamp()};
      this.persist(after);this.revoke(id);this.event('account.password-reset',id,actor,before,after,'负责人重置密码，已撤销旧会话');return publicAccount(after);
    });
  }
  loggedIn(id:string){const account=this.get(id);if(account)this.persist({...account,lastLoginAt:stamp()});}
}

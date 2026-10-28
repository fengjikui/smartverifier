import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash, scryptSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from '../server/store.ts';
import { AdminAuth } from '../server/admin/auth.ts';
import { adminLocalOnly, readAdminAccess } from '../server/admin/access-config.ts';
import type { AdminUser } from '../server/admin/access-config.ts';
import { configureAdminAccount, configureAdminAccess, localAdminEnvironment, updateLocalEnvironment } from '../scripts/admin-settings.ts';
import { startServer } from '../server/index.ts';
import { MARKING_API } from '../shared/paths.ts';
const password='Test-only-2026!',salt='test-only-salt-0123456789';
const user:AdminUser={id:'editor01',name:'测试录入员',salt,hash:scryptSync(password,salt,32).toString('hex')};
function request(address='127.0.0.1',cookie='',forwarded=false){return {socket:{remoteAddress:address},headers:{...(cookie?{cookie}:{}),...(forwarded?{'x-forwarded-for':'127.0.0.1'}:{})}} as IncomingMessage;}
function response(){const headers=new Map<string,string>();return {res:{setHeader:(key:string,value:string)=>headers.set(key,value)} as unknown as ServerResponse,headers};}
const credentials={id:user.id,code:password};
const cookieOf=(headers:Map<string,string>)=>headers.get('Set-Cookie')!.split(';')[0];

test('管理员开关默认仅本机；开放必须先配置账号，错误配置不回退到默认密码',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'sv-admin-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const value of [undefined,'','true','TRUE','1'])assert.equal(adminLocalOnly(value),true);
  for(const value of ['false','FALSE','0'])assert.equal(adminLocalOnly(value),false);
  assert.throws(()=>adminLocalOnly('lan'),/只能填/);
  assert.equal(readAdminAccess({},root).localOnly,true);
  assert.throws(()=>readAdminAccess({SV_ADMIN_LOCAL_ONLY:'false'},root),/独立账号密码/);
  const file=path.join(root,'users.json');await writeFile(file,JSON.stringify([user]));
  assert.equal(readAdminAccess({SV_ADMIN_USERS_FILE:'users.json'},root).localOnly,true,'设置账号文件本身不应开放远程');
  assert.equal(readAdminAccess({SV_ADMIN_USERS_FILE:'users.json',SV_ADMIN_LOCAL_ONLY:'false'},root).localOnly,false);
  await writeFile(file,JSON.stringify([{...user,hash:'broken'}]));
  assert.throws(()=>readAdminAccess({SV_ADMIN_USERS_FILE:file,SV_ADMIN_LOCAL_ONLY:'false'},root),/格式不正确/);
  await writeFile(file,JSON.stringify([user,user]));assert.throws(()=>readAdminAccess({SV_ADMIN_USERS_FILE:file},root),/格式不正确/);
});

test('配置助手保留模型配置，分人哈希保存账号，开关可逆且重复账号需明确更新',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'sv-admin-setup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'.env.local'),'# 保留模型配置\nSV_VLM_MODEL=existing-model\nSV_VLM_API_KEY="test-only-key"\nSV_ADMIN_LOCAL_ONLY=true\nSV_ADMIN_LOCAL_ONLY=true\n');
  assert.throws(()=>configureAdminAccess(root,'lan'),/独立账号密码/);
  const added=configureAdminAccount(root,{id:'editor01',name:'甲',password});
  configureAdminAccount(root,{id:'editor02',name:'乙',password});
  const content=await readFile(added.filename,'utf8'),users=JSON.parse(content);assert.equal(users.length,2);assert.ok(!content.includes(password));assert.notEqual(users[0].hash,users[1].hash);
  assert.throws(()=>configureAdminAccount(root,{id:'editor01',name:'甲',password}),/账号已存在/);
  assert.throws(()=>configureAdminAccount(root,{id:'weak',name:'甲',password:'admin123'}),/12/);
  configureAdminAccount(root,{id:'editor01',name:'甲更新',password:'Updated-test-only!'},true);
  assert.equal(configureAdminAccess(root,'lan').localOnly,false);assert.equal(configureAdminAccess(root,'local').localOnly,true);
  const environment=await readFile(path.join(root,'.env.local'),'utf8');assert.match(environment,/SV_VLM_MODEL=existing-model/);assert.match(environment,/SV_VLM_API_KEY="test-only-key"/);assert.equal(environment.match(/^SV_ADMIN_LOCAL_ONLY=/gm)!.length,1);
  assert.equal(readAdminAccess(localAdminEnvironment(root),root).users![0].name,'甲更新');
  if(process.platform!=='win32')assert.equal((await stat(added.filename)).mode&0o777,0o600);
  updateLocalEnvironment(root,{SV_ADMIN_LOCAL_ONLY:'false'});assert.equal(readAdminAccess(localAdminEnvironment(root),root).localOnly,false);
});

test('账号登录：远程限制、旧会话关闭、改密撤销、独立人员、退出与防暴力尝试',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-admin-auth-')),store=new Store(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const restricted=new AdminAuth(store,{users:[user],localOnly:true});
  await assert.rejects(()=>restricted.login(request('192.168.1.20'),response().res,credentials),/仅允许服务器本机/);
  await assert.rejects(()=>restricted.login(request('127.0.0.1','',true),response().res,credentials),/仅允许服务器本机/);
  const open=new AdminAuth(store,{users:[user],localOnly:false}),login=response();
  await assert.rejects(()=>open.login(request('192.168.1.20'),response().res,{...credentials,code:'wrong'}),/账号或密码/);
  const identity=await open.login(request('192.168.1.20'),login.res,credentials),cookie=cookieOf(login.headers);
  assert.deepEqual(identity.person,{id:user.id,name:user.name});assert.equal(identity.mode,'password');assert.equal(identity.localOnly,false);
  assert.equal(open.current(request('192.168.1.20',cookie))!.person.id,user.id);
  assert.equal(restricted.current(request('192.168.1.20',cookie)),null,'关闭访问后不得继续使用原远程会话');
  const changed=new AdminAuth(store,{users:[{...user,hash:'a'.repeat(64)}],localOnly:false});assert.equal(changed.current(request('192.168.1.20',cookie)),null,'改密码后旧会话失效');
  const removed=new AdminAuth(store,{users:[{...user,id:'other'}],localOnly:false});assert.equal(removed.current(request('192.168.1.20',cookie)),null,'移除账号后旧会话失效');
  open.logout(request('192.168.1.20',cookie),response().res);assert.equal(open.current(request('192.168.1.20',cookie)),null);
  const tries=await Promise.allSettled(Array.from({length:9},()=>open.login(request('192.168.1.30'),response().res,{...credentials,code:'wrong'})));
  assert.equal(tries.filter(result=>result.status==='rejected'&&result.reason.status===429).length,1,'并发登录不能绕过8次限制');
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM admin_sessions').all()).includes(password));
});

test('旧管理员会话表升级保留资料，本机默认身份不能自动升级为配置账号',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-admin-migration-')),store=new Store(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  store.db.exec('CREATE TABLE admin_sessions(token TEXT PRIMARY KEY,person TEXT NOT NULL,expires INTEGER NOT NULL,local_only INTEGER NOT NULL)');
  store.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?,?)').run(createHash('sha256').update('old-test-token').digest('hex'),JSON.stringify({id:'ADMIN-TRIAL',name:'试用管理员'}),Date.now()+60000,1);
  const local=new AdminAuth(store,{users:null,localOnly:true}),cookie='sv_admin_session=old-test-token';assert.equal(local.current(request('127.0.0.1',cookie))!.person.id,'ADMIN-TRIAL');
  assert.equal(local.current(request('192.168.1.20',cookie)),null);assert.equal(local.current(request('127.0.0.1',cookie,true)),null);
  const configured=new AdminAuth(store,{users:[user],localOnly:false});assert.equal(configured.current(request('127.0.0.1',cookie)),null);
  await assert.rejects(()=>configured.login(request(),response().res,{id:'admin',code:'admin123'}),/账号或密码/);
});

test('管理HTTP使用配置账号录入并记录人员；公开配置不泄密，模型调试仍限制本机',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sv-admin-lan-')),file=path.join(directory,'users.json');await writeFile(file,JSON.stringify([user]));
  const prior={file:process.env.SV_ADMIN_USERS_FILE,scope:process.env.SV_ADMIN_LOCAL_ONLY};process.env.SV_ADMIN_USERS_FILE=file;process.env.SV_ADMIN_LOCAL_ONLY='false';
  const {server,service,admin}=startServer({state:directory,host:'127.0.0.1',port:0,debug:true,delay:1});
  t.after(async()=>{for(const [key,value] of [['SV_ADMIN_USERS_FILE',prior.file],['SV_ADMIN_LOCAL_ONLY',prior.scope]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}admin.files.close();service.closing=true;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));service.store.close();await rm(directory,{recursive:true,force:true});});
  await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port+MARKING_API,headers={'Content-Type':'application/json','X-Forwarded-For':'192.168.1.20'};
  const config=await(await fetch(base+'/admin/config')).json();assert.deepEqual(config,{accessMode:'password',localOnly:false});assert.ok(!JSON.stringify(config).includes(user.hash));
  const login=await fetch(base+'/admin/session',{method:'POST',headers,body:JSON.stringify(credentials)});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const record=await fetch(base+'/admin/standards',{method:'POST',headers:{...headers,Cookie:cookie},body:JSON.stringify({material:'TEST-LAN',modelNumber:'M1',supplier:'测试供应商',status:'draft'})});assert.equal(record.status,201);const standard=await record.json();assert.equal(standard.updatedBy.id,user.id);
  const audit=await(await fetch(base+'/admin/audit-logs',{headers:{...headers,Cookie:cookie}})).json();assert.ok(audit.items.some((item:{actor:{id:string}})=>item.actor.id===user.id));
  const inspector=await fetch(base+'/session',{method:'POST',headers,body:'{}'});const inspectorCookie=inspector.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(base+'/admin/standards',{headers:{...headers,Cookie:inspectorCookie}})).status,401);
  assert.equal((await fetch(base+'/debug/traces',{headers:{...headers,Cookie:inspectorCookie}})).status,403);
});

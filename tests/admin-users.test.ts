import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { scryptSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from '../server/store.ts';
import { AdminAuth } from '../server/admin/auth.ts';
import { ApiError } from '../server/errors.ts';
import { startServer } from '../server/index.ts';
import { configureAdminAccount, localAdminEnvironment } from '../scripts/admin-settings.ts';
import { readAdminAccess } from '../server/admin/access-config.ts';
import { MARKING_API, adminPath, adminRoute, canonicalPage } from '../shared/paths.ts';
import type { AdminUser } from '../server/admin/access-config.ts';
import type { AdminAccount, AccessEvent } from '../shared/admin.ts';
const password='Test-only-initial-2026!',newPassword='Test-only-updated-2026!';
const owner:AdminUser={id:'system01',name:'测试负责人',role:'owner',salt:'owner-test-salt-2026',hash:scryptSync(password,'owner-test-salt-2026',32).toString('hex')};
const legacy:AdminUser={id:'legacy01',name:'旧录入员',salt:'legacy-test-salt-2026',hash:scryptSync(password,'legacy-test-salt-2026',32).toString('hex')};
const actor={id:owner.id,name:owner.name};
const localRequest=(cookie='')=>({socket:{remoteAddress:'127.0.0.1'},headers:{cookie}} as IncomingMessage);
function captureResponse(){let cookie='';return {response:{setHeader:(_key:string,value:string)=>cookie=value.split(';')[0]} as unknown as ServerResponse,get cookie(){return cookie;}};}

test('人员页面地址规范；负责人显式配置，旧账号和 admin 名称不会自动成为负责人',async t=>{
  assert.equal(adminPath('users'),'/inspections/marking/admin/users');assert.equal(adminRoute(adminPath('users')),'users');assert.equal(canonicalPage(adminPath('users')),adminPath('users'));
  const root=await mkdtemp(path.join(tmpdir(),'sv-owner-setup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  configureAdminAccount(root,{id:'admin',name:'普通录入',password});
  assert.equal(readAdminAccess(localAdminEnvironment(root),root).users![0].role,'standard_admin');
  configureAdminAccount(root,{id:'system01',name:'负责人',password},false,'owner');
  configureAdminAccount(root,{id:'system01',name:'负责人更新',password:newPassword},true);
  assert.equal(readAdminAccess(localAdminEnvironment(root),root).users!.find(user=>user.id==='system01')!.role,'owner','普通 --replace 不应意外降级已配置负责人');
});

test('默认本机试用账号没有授权能力；配置账号存在时不能回退默认密码',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'sv-trial-role-')),store=new Store(root);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const trial=new AdminAuth(store,{users:null,localOnly:true}),res=captureResponse(),session=await trial.login(localRequest(),res.response,{id:'admin',code:'admin123'});
  assert.equal(session.role,'standard_admin');assert.throws(()=>trial.requireOwner(localRequest(res.cookie)),/仅系统负责人/);
  new AdminAuth(store,{users:[owner,legacy],localOnly:true});assert.throws(()=>new AdminAuth(store,{users:null,localOnly:true}),/不能回退/);
});

test('服务器改密不意外启用停用人员，离线恢复负责人可重新取得授权入口',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'sv-owner-recovery-')),store=new Store(root);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const auth=new AdminAuth(store,{users:[owner,legacy],localOnly:true}),account=auth.accounts.get(legacy.id)!;
  auth.accounts.status(legacy.id,account.version,'disabled','结束录入',()=>actor);
  const changed={...legacy,hash:scryptSync(newPassword,legacy.salt,32).toString('hex')};
  const updated=new AdminAuth(store,{users:[owner,changed],localOnly:true});assert.equal(updated.accounts.get(legacy.id)!.status,'disabled');
  await assert.rejects(()=>updated.login(localRequest(),captureResponse().response,{id:legacy.id,code:newPassword}),/已停用/);
  const removed=new AdminAuth(store,{users:[changed],localOnly:true});assert.equal(removed.accounts.get(owner.id)!.status,'disabled');
  const restored=new AdminAuth(store,{users:[owner,changed],localOnly:true}),res=captureResponse();assert.equal((await restored.login(localRequest(),res.response,{id:owner.id,code:password})).role,'owner');
  assert.ok(restored.requireOwner(localRequest(res.cookie)));assert.equal(restored.accounts.get(legacy.id)!.status,'disabled');
});

test('管理HTTP隔离负责人权限；停用立即撤销会话，保留资料，授权日志不含凭证',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'sv-users-http-')),file=path.join(root,'users.json');await writeFile(file,JSON.stringify([owner,legacy]));
  const previous={users:process.env.SV_ADMIN_USERS_FILE,local:process.env.SV_ADMIN_LOCAL_ONLY};process.env.SV_ADMIN_USERS_FILE=file;process.env.SV_ADMIN_LOCAL_ONLY='false';
  let running:ReturnType<typeof startServer>|undefined,base='';
  async function start(){running=startServer({state:path.join(root,'data'),port:0,host:'127.0.0.1',real:false,debug:false,delay:1});await once(running.server,'listening');const address=running.server.address();assert.ok(address&&typeof address!=='string');base='http://127.0.0.1:'+address.port+MARKING_API;}
  async function close(){if(!running)return;running.admin.files.close();running.service.closing=true;running.server.closeAllConnections();await new Promise<void>(resolve=>running!.server.close(()=>resolve()));running.service.store.close();running=undefined;}
  t.after(async()=>{await close();if(previous.users===undefined)delete process.env.SV_ADMIN_USERS_FILE;else process.env.SV_ADMIN_USERS_FILE=previous.users;if(previous.local===undefined)delete process.env.SV_ADMIN_LOCAL_ONLY;else process.env.SV_ADMIN_LOCAL_ONLY=previous.local;await rm(root,{recursive:true,force:true});});
  await start();
  async function call(route:string,cookie='',data?:unknown,expected=200,method?:string){const response=await fetch(base+route,{method:method??(data===undefined?'GET':'POST'),headers:{...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;}
  async function login(id:string,code=password){const response=await fetch(base+'/admin/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,code})});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie')!.split(';')[0],session:await response.json()};}
  const rootLogin=await login(owner.id),ordinary=await login(legacy.id);assert.equal(rootLogin.session.role,'owner');assert.equal(ordinary.session.role,'standard_admin');
  await call('/admin/users','',undefined,401);
  for(const [route,data,method] of [['/admin/users',undefined,'GET'],['/admin/access-events',undefined,'GET'],['/admin/users',{id:'attacker',name:'恶意提升',password,role:'owner'},'POST'],['/admin/users/legacy01/status',{version:1,status:'disabled',reason:'不得操作'},'POST'],['/admin/users/legacy01/password',{version:1,password:newPassword},'POST'],['/admin/users/legacy01',{version:1,name:'不能改'},'PUT'] ] as const)await call(route,ordinary.cookie,data,403,method);
  await call('/admin/users',rootLogin.cookie,{id:'forgedOwner',name:'不能提升',password,role:'owner'},400);
  const listing=await call('/admin/users',rootLogin.cookie);assert.equal(listing.items.find((item:AdminAccount)=>item.id===legacy.id).role,'standard_admin');
  for(const item of listing.items)for(const secret of ['salt','hash','seed','password'])assert.ok(!(secret in item));
  await call('/admin/users/system01/status',rootLogin.cookie,{version:1,status:'disabled',reason:'不得锁住负责人'},403);
  await call('/admin/users/system01/password',rootLogin.cookie,{version:1,password:newPassword},403);
  await call('/admin/users/system01',rootLogin.cookie,{version:1,name:'不得改负责人'},403,'PUT');
  await call('/admin/users/system01',rootLogin.cookie,{},405,'DELETE');
  let account:AdminAccount=await call('/admin/users',rootLogin.cookie,{id:'editor02',name:'新录入员',password},201);assert.equal(account.role,'standard_admin');
  const staff=await login(account.id);assert.equal(staff.session.role,'standard_admin');
  const standard=await call('/admin/standards',staff.cookie,{material:'KEEP-AFTER-DISABLE',supplier:'测试供应商',status:'draft'},201);
  await call('/admin/users/editor02',rootLogin.cookie,{version:account.version,name:'不能改角色',role:'owner'},400,'PUT');
  account=await call('/admin/users/editor02/status',rootLogin.cookie,{version:account.version,status:'disabled',reason:'项目录入结束'});
  await call('/admin/standards',staff.cookie,undefined,401);await call('/admin/session','',{id:account.id,code:password},403);
  await call('/admin/users',rootLogin.cookie,{id:account.id,name:'不能复用历史账号',password},409);
  await call('/admin/users/editor02/status',rootLogin.cookie,{version:1,status:'active',reason:'旧版本不能覆盖'},409);
  account=await call('/admin/users/editor02/password',rootLogin.cookie,{version:account.version,password:newPassword});assert.equal(account.status,'disabled','重置密码不应自动启用停用账号');
  await call('/admin/session','',{id:account.id,code:newPassword},403);
  account=await call('/admin/users/editor02/status',rootLogin.cookie,{version:account.version,status:'active',reason:'继续录入'});await call('/admin/standards',staff.cookie,undefined,401,'GET');
  await call('/admin/session','',{id:account.id,code:password},401);const restored=await login(account.id,newPassword);await call('/admin/standards',restored.cookie);
  account=await call('/admin/users/editor02',rootLogin.cookie,{version:account.version,name:'新姓名'},200,'PUT');await call('/admin/standards',restored.cookie,undefined,401);
  const history=await call('/admin/standards/'+standard.id,rootLogin.cookie);assert.equal(history.record.updatedBy.name,'新录入员','历史维护姓名不能被账号改名改写');
  const legacyAccount=(await call('/admin/users',rootLogin.cookie)).items.find((item:AdminAccount)=>item.id===legacy.id);
  await call('/admin/users/legacy01/status',rootLogin.cookie,{version:legacyAccount.version,status:'disabled',reason:'旧配置账号停用'});
  const logs=await call('/admin/access-events',rootLogin.cookie);assert.ok(logs.items.some((event:AccessEvent)=>event.action==='account.disable'&&event.actor.id===owner.id&&event.reason==='项目录入结束'));
  const logText=JSON.stringify(logs);for(const secret of [password,newPassword,owner.hash,owner.salt,legacy.hash])assert.ok(!logText.includes(secret));
  const count=logs.total;await close();await start();
  const afterRestart=await call('/admin/users',rootLogin.cookie);assert.equal(afterRestart.items.find((item:AdminAccount)=>item.id===legacy.id).status,'disabled','相同服务器配置不能在重启时重新启用已停用人员');
  assert.equal((await call('/admin/access-events',rootLogin.cookie)).total,count,'重启不应重复写授权日志');
  assert.equal((await call('/admin/users?q='+account.id,rootLogin.cookie)).items[0].name,'新姓名');
  assert.equal((await call('/admin/users?q=%25',rootLogin.cookie)).total,0);
});

test('密码重置跨重启保留，日志写入失败时账号和会话同时回滚，退出可撤销等待中的授权操作',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'sv-users-atomic-')),store=new Store(root);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const auth=new AdminAuth(store,{users:[owner,legacy],localOnly:true});
  const res=captureResponse();await auth.login(localRequest(),res.response,{id:owner.id,code:password});const req=localRequest(res.cookie),authorize=()=>auth.requireOwner(req);
  const before=auth.accounts.get(legacy.id)!;
  await auth.accounts.resetPassword(legacy.id,before.version,newPassword,authorize);
  const restarted=new AdminAuth(store,{users:[owner,legacy],localOnly:true});
  await assert.rejects(()=>restarted.login(localRequest(),captureResponse().response,{id:legacy.id,code:password}),/账号或密码/);
  const staffRes=captureResponse();await restarted.login(localRequest(),staffRes.response,{id:legacy.id,code:newPassword});
  store.db.exec("CREATE TRIGGER fail_access_log BEFORE INSERT ON admin_access_events BEGIN SELECT RAISE(ABORT, 'test-audit-unavailable'); END");
  const version=restarted.accounts.get(legacy.id)!.version;
  assert.throws(()=>restarted.accounts.status(legacy.id,version,'disabled','测试原子性',authorize),/test-audit-unavailable/);
  assert.equal(restarted.accounts.get(legacy.id)!.status,'active');assert.ok(restarted.current(localRequest(staffRes.cookie)),'失败的停用不能留下半次会话撤销');
  await assert.rejects(()=>restarted.accounts.create({id:'rollback',name:'不会落库',password},authorize),/test-audit-unavailable/);assert.equal(restarted.accounts.get('rollback'),null);
  store.db.exec('DROP TRIGGER fail_access_log');
  const pending=restarted.accounts.create({id:'afterLogout',name:'不能授权',password},()=>restarted.requireOwner(req));restarted.logout(req,captureResponse().response);
  await assert.rejects(()=>pending,/重新登录/);assert.equal(restarted.accounts.get('afterLogout'),null);
  assert.equal(auth.accounts.page('', 'active').items.find(item=>item.id===owner.id)!.role,'owner');
});

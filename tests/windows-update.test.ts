import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { runUpdate, updatePlan, redact } from '../scripts/update-windows.ts';
import { acquireLease, assertLeaseFree, serviceLeasePath, updateLeasePath, stateUpdateLeasePath } from '../server/local-lease.ts';
import { pythonExecutable } from '../server/python-runtime.ts';

const project=fileURLToPath(new URL('../',import.meta.url));
const checksum=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const secret='fixture-secret-ONLY-not-a-real-key';
function git(root:string,...args:string[]){return execFileSync('git',['-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
async function freePort(){const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,'0.0.0.0',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
type Context={after:(fn:()=>unknown)=>unknown};
async function fixture(t:Context,options:{external?:boolean;protectedTarget?:boolean}={}){
  const base=await mkdtemp(path.join(tmpdir(),'鉴微 update 测试 ')),root=path.join(base,'原 安装目录'),remote=path.join(base,'remote.git');
  await mkdir(root);t.after(()=>rm(base,{recursive:true,force:true}));
  git(base,'init','--bare',remote);git(root,'init','-b','main');git(root,'config','user.name','Update Fixture');git(root,'config','user.email','fixture@example.test');
  await writeFile(path.join(root,'.gitignore'),'/var/\n.env*\n/node_modules/\n/dist/\n/.venv/\n');
  await writeFile(path.join(root,'package.json'),JSON.stringify({name:'jianwei',version:'0.0.0',private:true,scripts:{check:'node check.cjs',build:'node build.cjs'}}));
  await writeFile(path.join(root,'package-lock.json'),JSON.stringify({name:'jianwei',version:'0.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'jianwei',version:'0.0.0'}}}));
  await writeFile(path.join(root,'requirements.txt'),'# intentionally empty offline fixture\n');
  await writeFile(path.join(root,'check.cjs'),'process.stdout.write("KEY="+process.env.SV_VLM_API_KEY.slice(0,8));setTimeout(()=>console.log(process.env.SV_VLM_API_KEY.slice(8)),15);console.log("https://user:password@example.test/v1?token=fixture#private");');
  await writeFile(path.join(root,'build.cjs'),'if(process.env.SV_FIXTURE_BUILD_FAIL){console.error("fixture build failure");process.exit(7)};require("node:fs").mkdirSync("dist",{recursive:true});require("node:fs").writeFileSync("dist/index.html","built");');
  for(const filename of ['update-windows.cmd','scripts/update-windows.ts','server/python-runtime.ts','server/local-lease.ts']){await mkdir(path.dirname(path.join(root,filename)),{recursive:true});await copyFile(path.join(project,filename),path.join(root,filename));}
  git(root,'add','.');git(root,'commit','-m','initial');const before=git(root,'rev-parse','HEAD');git(root,'remote','add','origin',remote);git(root,'push','-u','origin','main');
  await writeFile(path.join(root,'release.txt'),'new-version');
  await writeFile(path.join(root,'update-windows.cmd'),'@rem New launcher revision to exercise self-update.\n'+await readFile(path.join(root,'update-windows.cmd'),'utf8'));
  if(options.protectedTarget){await writeFile(path.join(root,'.env.local'),'SHOULD_NOT_REPLACE=1\n');git(root,'add','-f','.env.local');}
  git(root,'add','release.txt','update-windows.cmd');git(root,'commit','-m','target');const target=git(root,'rev-parse','HEAD');git(root,'push','origin','main');git(root,'reset','--hard',before);
  const state=options.external?path.join(base,'外部 业务数据'):path.join(root,'var/data');await mkdir(path.join(state,'files'),{recursive:true});
  const db=new DatabaseSync(path.join(state,'inspection.sqlite'));db.exec('CREATE TABLE original_records(value TEXT);INSERT INTO original_records VALUES(\'正品、管理员与审计应保留\')');db.close();
  const picture=path.join(state,'files','原始 图片.png');await writeFile(picture,Buffer.from([0,255,1,99,88]));
  const account=options.external?path.join(base,'外部 账号','admins.json'):path.join(root,'var/config/admin-users.json');await mkdir(path.dirname(account),{recursive:true});await writeFile(account,JSON.stringify([{id:'owner-fixture',hash:'original-hash-never-reset'}]));
  await mkdir(path.join(root,'var'),{recursive:true});await writeFile(path.join(root,'var','extra-private-file.txt'),'preserve whole var');
  const venv=path.join(root,'.venv');execFileSync(pythonExecutable(project),['-m','venv','--without-pip',venv],{encoding:'utf8'});
  const python=pythonExecutable(root,''),port=await freePort();
  const config=path.join(root,'.env.local');await writeFile(config,'SV_STATE_DIR='+JSON.stringify(state.replaceAll('\\','/'))+'\nSV_ADMIN_USERS_FILE='+JSON.stringify(account.replaceAll('\\','/'))+'\nSV_PORT='+port+'\nSV_VISION_PYTHON='+JSON.stringify(python.replaceAll('\\','/'))+'\nSV_VLM_API_KEY='+secret+'\nSV_ADMIN_LOCAL_ONLY=false\n');
  const env={...process.env};for(const key of ['SV_STATE_DIR','SV_ADMIN_USERS_FILE','SV_PORT','SV_VISION_PYTHON','SV_VLM_API_KEY','SV_ADMIN_LOCAL_ONLY'])delete env[key];
  const protectedFiles=[config,account,picture,path.join(state,'inspection.sqlite'),path.join(root,'var/extra-private-file.txt')];
  const hashes=await Promise.all(protectedFiles.map(async name=>checksum(await readFile(name))));
  const unchanged=async()=>assert.deepEqual(await Promise.all(protectedFiles.map(async name=>checksum(await readFile(name)))),hashes);
  const backupBase=path.join(base,'独立 备份');
  const latestResult=async()=>{const dirs=(await readdir(backupBase)).sort();return JSON.parse(await readFile(path.join(backupBase,dirs.at(-1)!,'result.json'),'utf8'));};
  return {base,root,remote,state,account,config,port,before,target,env,backupBase,unchanged,latestResult};
}

test('日志脱敏覆盖配置密钥、URL凭证／查询和Bearer，保留排错所需的阶段信息',()=>{
  const output=redact('阶段 install '+secret+' https://u:pass@example.test/pkg?token=xxx#key Bearer abc-def api_key=qwerty',[secret]);
  for(const token of [secret,'u:pass','token=xxx','#key','abc-def','qwerty'])assert.ok(!output.includes(token));assert.match(output,/阶段 install/);
  assert.ok(!redact(secret.slice(8),[secret]).includes(secret.slice(8)));
});

test('本机租约阻止重复更新与启动，只释放本进程取得的锁',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'sv-lease-'));t.after(()=>rm(base,{recursive:true,force:true}));const lock=path.join(base,'lock');
  const release=acquireLease(lock,base);assert.throws(()=>acquireLease(lock,base),/PID/);assert.throws(()=>assertLeaseFree(lock),/PID/);release();assertLeaseFree(lock);
  await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:2147483000,nonce:'stale'}));assertLeaseFree(lock);assert.equal(existsSync(lock),false);
});

test('配置路径尊重环境变量优先级；缺失原库或账号文件时拒绝误更新空项目',async t=>{
  const f=await fixture(t,{external:true});const plan=updatePlan(f.root,f.env);assert.equal(plan.state,f.state);assert.equal(plan.account,f.account);
  assert.throws(()=>updatePlan(f.root,{...f.env,SV_STATE_DIR:path.join(f.base,'does-not-exist')}),/数据库/);
  assert.throws(()=>updatePlan(f.root,{...f.env,SV_ADMIN_USERS_FILE:path.join(f.base,'missing.json')}),/管理员文件/);
  assert.throws(()=>updatePlan(f.root,{...f.env,SV_PORT:'invalid'}),/端口/);await f.unchanged();
});

test('实际快进、npm ci、pip安装和构建完整跑通，默认数据与外部账号逐字节保留并可核验备份',async t=>{
  const f=await fixture(t,{external:true});const result=await runUpdate({root:f.root,env:f.env,backupBase:f.backupBase,quiet:!process.env.SV_UPDATE_TRACE});
  assert.equal(result.success,true);assert.equal(result.backupComplete,true);assert.equal(result.protectedVerified,true);assert.ok(result.finishedAt);assert.equal(git(f.root,'rev-parse','HEAD'),f.target);assert.equal(result.beforeCommit,f.before);assert.equal(await readFile(path.join(f.root,'dist/index.html'),'utf8'),'built');await f.unchanged();
  const manifest=JSON.parse(await readFile(path.join(result.runDirectory,'private-backup/manifest.json'),'utf8'));
  assert.ok(manifest.files.some((file:{destination:string})=>file.destination.includes('external-state')));assert.ok(manifest.files.some((file:{destination:string})=>file.destination.includes('external-admin')));
  for(const file of manifest.files)assert.equal(checksum(await readFile(path.join(result.runDirectory,'private-backup',file.destination))),file.sha256);
  const log=await readFile(path.join(result.runDirectory,'update.log'),'utf8');assert.ok(!log.includes(secret));assert.ok(!log.includes(secret.slice(8)));assert.ok(!log.includes('user:password'));assert.ok(!log.includes('token=fixture'));assert.match(log,/已隐藏/);
  assert.equal(existsSync(updateLeasePath(f.root)),false);assert.equal(existsSync(stateUpdateLeasePath(f.state)),false);
});

test('默认 var 数据备份；本地改动、占用端口与活跃服务均阻断更新且不结束原进程',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.root,'local-change.txt'),'do not delete');await assert.rejects(runUpdate({root:f.root,env:f.env,backupBase:f.backupBase,quiet:true}),/本地代码改动/);assert.equal(git(f.root,'rev-parse','HEAD'),f.before);await rm(path.join(f.root,'local-change.txt'));
  const server=net.createServer();await new Promise<void>(resolve=>server.listen(f.port,'0.0.0.0',resolve));
  try{await assert.rejects(runUpdate({root:f.root,env:f.env,backupBase:f.backupBase,quiet:true}),/端口/);assert.ok(server.listening);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  const release=acquireLease(serviceLeasePath(f.state),f.root);
  try{await assert.rejects(runUpdate({root:f.root,env:f.env,backupBase:f.backupBase,quiet:true}),/PID/);assert.ok(existsSync(serviceLeasePath(f.state)));}finally{release();}
  const result=await runUpdate({root:f.root,env:f.env,backupBase:f.backupBase,quiet:true});assert.equal(result.success,true);await f.unchanged();
  const manifest=JSON.parse(await readFile(path.join(result.runDirectory,'private-backup/manifest.json'),'utf8'));assert.ok(manifest.files.some((file:{destination:string})=>file.destination.includes(path.join('var','data','inspection.sqlite'))));
});

test('获取远端失败或目标包含私有配置时，在已校验备份之后停止，不覆盖正品与账号',async t=>{
  const f=await fixture(t);git(f.root,'remote','set-url','origin',path.join(f.base,'missing-remote.git'));
  await assert.rejects(runUpdate({root:f.root,env:f.env,backupBase:f.backupBase,quiet:true}),/退出码/);assert.equal((await f.latestResult()).backupComplete,true);assert.equal(git(f.root,'rev-parse','HEAD'),f.before);assert.equal(existsSync(path.join(f.root,'node_modules')),false);await f.unchanged();
  const protectedFixture=await fixture(t,{protectedTarget:true});
  await assert.rejects(runUpdate({root:protectedFixture.root,env:protectedFixture.env,backupBase:protectedFixture.backupBase,quiet:true}),/受保护/);assert.equal((await protectedFixture.latestResult()).backupComplete,true);assert.equal(git(protectedFixture.root,'rev-parse','HEAD'),protectedFixture.before);await protectedFixture.unchanged();
});

test('构建非零立即失败，记录阶段和退出码，保留备份及原资料，并支持再次更新',async t=>{
  const f=await fixture(t);
  await assert.rejects(runUpdate({root:f.root,env:{...f.env,SV_FIXTURE_BUILD_FAIL:'1'},backupBase:f.backupBase,quiet:true}),/退出码 7/);
  const failed=await f.latestResult();assert.equal(failed.failedStage,'构建前端');assert.equal(failed.backupComplete,true);assert.equal(failed.protectedVerified,false);assert.equal(failed.stages.at(-1).exitCode,7);assert.ok(failed.stages.every((stage:{name:string})=>stage.name!=='核对数据与配置未被改写'));await f.unchanged();
  const retried=await runUpdate({root:f.root,env:f.env,backupBase:f.backupBase,quiet:true});assert.equal(retried.success,true);await f.unchanged();
});

test('备份目录嵌入项目或数据源、源含目录联接时拒绝继续，check模式不拉取或安装',async t=>{
  const f=await fixture(t);await assert.rejects(runUpdate({root:f.root,env:f.env,backupBase:path.join(f.root,'bad-backup'),quiet:true}),/备份位置/);
  const outside=path.join(f.base,'linked');await mkdir(outside);await writeFile(path.join(outside,'secret.txt'),'do not follow');
  const link=path.join(f.root,'var/linked');await symlink(outside,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(runUpdate({root:f.root,env:f.env,backupBase:f.backupBase,quiet:true}),/符号链接／目录联接/);assert.equal((await f.latestResult()).backupComplete,false);await rm(link);
  const checked=await runUpdate({root:f.root,env:f.env,backupBase:f.backupBase,checkOnly:true,quiet:true});assert.equal(checked.success,true);assert.equal(checked.backupComplete,false);assert.equal(git(f.root,'rev-parse','HEAD'),f.before);assert.equal(existsSync(path.join(f.root,'node_modules')),false);await f.unchanged();
});

test('Windows CMD在中文空格路径中实际预检并完成自更新、备份、安装和构建', {skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);
  const result=spawnSync('cmd.exe',['/d','/s','/c',`""${path.join(f.root,'update-windows.cmd')}" --check"`],{cwd:f.base,env:{...f.env,SV_UPDATE_NO_PAUSE:'1'},encoding:'utf8',windowsVerbatimArguments:true,timeout:30000});
  assert.equal(result.status,0,result.error?.message??result.stdout+result.stderr);assert.match(result.stdout,/预检通过/);assert.equal(git(f.root,'rev-parse','HEAD'),f.before);await f.unchanged();
  const full=spawnSync('cmd.exe',['/d','/s','/c',`""${path.join(f.root,'update-windows.cmd')}""`],{cwd:f.base,env:{...f.env,SV_UPDATE_NO_PAUSE:'1'},encoding:'utf8',windowsVerbatimArguments:true,timeout:90000});
  assert.equal(full.status,0,full.error?.message??full.stdout+full.stderr);assert.match(full.stdout,/更新完成/);assert.equal(git(f.root,'rev-parse','HEAD'),f.target);assert.equal(await readFile(path.join(f.root,'dist/index.html'),'utf8'),'built');await f.unchanged();
});

test('业务启动入口在更新期间拒绝启动，保护同一数据目录且不改写原库',async t=>{
  const f=await fixture(t),release=acquireLease(stateUpdateLeasePath(f.state),f.root);
  try{
    const result=spawnSync(process.execPath,[path.join(project,'scripts/start.ts')],{cwd:project,env:{...f.env,SV_STATE_DIR:f.state,SV_PORT:String(f.port),SV_RECOGNIZER:'mock',SV_ADMIN_USERS_FILE:f.account,SV_ADMIN_LOCAL_ONLY:'true'},encoding:'utf8',timeout:15000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/仍在运行/);await f.unchanged();
  }finally{release();}
});

test('业务正常启动取得数据目录租约，第二个服务被拒绝，结束后可安全回收',async t=>{
  const f=await fixture(t);
  const env={...f.env,SV_STATE_DIR:f.state,SV_PORT:String(f.port),SV_RECOGNIZER:'mock',SV_MODEL_DEBUG:'0',SV_ADMIN_USERS_FILE:'',SV_ADMIN_LOCAL_ONLY:'true'};
  const child=spawn(process.execPath,[path.join(project,'scripts/start.ts')],{cwd:project,env,stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  try{
    let ready=false;for(let i=0;i<80;i++){try{ready=(await fetch(`http://127.0.0.1:${f.port}/api/v1/inspections/marking/health`)).ok;}catch{}if(ready)break;if(child.exitCode!==null)break;await delay(50);}
    assert.ok(ready,output);assert.ok(existsSync(serviceLeasePath(f.state)));
    const second=spawnSync(process.execPath,[path.join(project,'scripts/start.ts')],{cwd:project,env,encoding:'utf8',timeout:10000});assert.notEqual(second.status,0);assert.match(second.stderr,/仍在运行/);
  }finally{if(child.exitCode===null){const closed=once(child,'close');child.kill('SIGTERM');await closed;}}
  assertLeaseFree(serviceLeasePath(f.state));assert.equal(existsSync(serviceLeasePath(f.state)),false);
});

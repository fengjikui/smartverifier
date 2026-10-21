/** 无第三方依赖的更新器；先验证备份，再允许 Git 和依赖更新。不会启动业务服务。 */
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statfsSync } from 'node:fs';
import { readdir, lstat, stat, copyFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { pythonEnvironment, pythonExecutable } from '../server/python-runtime.ts';
import { acquireLease, assertLeaseFree, updateLeasePath, stateUpdateLeasePath, serviceLeasePath } from '../server/local-lease.ts';

type Source={source:string;destination:string};
type Entry={source:string;destination:string;bytes:number;mtimeMs:number};
type Saved=Entry&{sha256:string};
type Stage={name:string;startedAt:string;finishedAt?:string;status:'running'|'passed'|'failed';exitCode?:number};
export type UpdateOptions={root:string;backupBase?:string;env?:NodeJS.ProcessEnv;checkOnly?:boolean;signal?:AbortSignal;quiet?:boolean};
const internalNames=new Set(['.update-lock','.service-lock']);
const secretName=/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTHORIZATION|CREDENTIAL)/i;

export function redact(text:string,secrets:string[]=[]){
  let value=text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
  for(const secret of [...new Set(secrets)].filter(s=>s.length>=4).sort((a,b)=>b.length-a.length))value=value.split(secret).join('[已隐藏]');
  value=value.replace(/https?:\/\/[^\s<>"']+/gi,raw=>{try{const u=new URL(raw);if(u.username||u.password){u.username='hidden';u.password='hidden';}if(u.search)u.search='?hidden';u.hash='';return u.toString();}catch{return '[地址已隐藏]';}});
  // 异步子进程日志可能把密钥拆开并夹入别的行；也隐藏可确认的长凭证片段。
  const longSecrets=secrets.filter(s=>s.length>=12);
  value=value.replace(/[A-Za-z0-9_+/-]{8,}/g,token=>longSecrets.some(s=>s.includes(token.slice(0,8))||s.includes(token.slice(-8)))?'[已隐藏]':token);
  return value.replace(/\bBearer\s+[^\s"']+/gi,'Bearer [已隐藏]').replace(/((?:_authToken|password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]');
}

export function inside(parent:string,filename:string){const relative=path.relative(parent,filename);return !relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function canonical(filename:string){const value=path.resolve(filename);return process.platform==='win32'?value.toLowerCase():value;}
const legacyPython=(value:string|undefined)=>/^\.?[\\/]?\.venv[\\/]bin[\\/]python$/.test(value?.trim()??'');

export function updatePlan(root:string,parent:NodeJS.ProcessEnv=process.env){
  root=path.resolve(root);
  const configFile=path.join(root,'.env.local'),fileEnv=existsSync(configFile)?parseEnv(readFileSync(configFile,'utf8')):{};
  const env={...fileEnv,...parent};
  const state=path.resolve(root,env.SV_STATE_DIR??'var/data');
  if(inside(state,root))throw new Error('数据目录不能是项目目录或它的上级目录；请按部署说明手工更新。');
  const account=path.resolve(root,env.SV_ADMIN_USERS_FILE?.trim()||'var/config/admin-users.json');
  const port=Number(env.SV_PORT??5190);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('SV_PORT 必须是 1–65535 的有效端口。');
  if(env.SV_ADMIN_USERS_FILE?.trim()&&!existsSync(account))throw new Error('配置的管理员文件不存在，无法确认账号备份；请检查 SV_ADMIN_USERS_FILE。');
  if(!existsSync(path.join(state,'inspection.sqlite')))throw new Error('没有找到原业务数据库，请检查 SV_STATE_DIR；更新器不用于初始化空项目。');
  const sources:Source[]=[];
  for(const [source,destination] of [[configFile,'config/.env.local'],[path.join(root,'var'),'var'],[state,'external-state'],[account,'external-admin/admin-users.json']]){
    if(existsSync(source)&&!sources.some(s=>inside(s.source,source)))sources.push({source,destination});
  }
  const platform=process.platform;
  if(platform==='win32'&&legacyPython(parent.SV_VISION_PYTHON))throw new Error('终端环境变量 SV_VISION_PYTHON 仍指向 macOS 路径，请先移除该终端／系统变量再更新。');
  const repairPython=platform==='win32'&&legacyPython(fileEnv.SV_VISION_PYTHON)&&!parent.SV_VISION_PYTHON;
  const python=pythonExecutable(root,repairPython?'':env.SV_VISION_PYTHON);
  return {root,env,fileEnv,state,account,configFile,port,sources,repairPython,python};
}

async function inventory(sources:Source[]):Promise<Entry[]>{
  const result:Entry[]=[];
  async function visit(source:string,destination:string){
    const info=await lstat(source);
    if(info.isSymbolicLink())throw new Error('备份源包含符号链接／目录联接，无法保证完整备份，请先按部署说明手工处理。');
    if(info.isDirectory()){
      for(const name of (await readdir(source)).sort())if(!internalNames.has(name))await visit(path.join(source,name),path.join(destination,name));
    }else if(info.isFile())result.push({source,destination,bytes:info.size,mtimeMs:info.mtimeMs});
    else throw new Error('备份源包含不支持的文件类型，已停止。');
  }
  for(const s of sources)await visit(s.source,s.destination);
  return result;
}
async function hash(filename:string){const digest=createHash('sha256');for await(const chunk of createReadStream(filename))digest.update(chunk);return digest.digest('hex');}
async function verifySources(saved:Saved[],sources:Source[],allowed?:{file:string;sha256:string}){
  const current=await inventory(sources);
  if(current.length!==saved.length||current.some((e,i)=>e.source!==saved[i].source||(e.source!==allowed?.file&&e.bytes!==saved[i].bytes)))throw new Error('受保护的数据／配置文件清单发生变化，已停止，请检查备份和业务服务状态。');
  for(const e of saved)if(await hash(e.source)!==(allowed?.file===e.source?allowed.sha256:e.sha256))throw new Error('受保护的数据／配置内容发生变化，已停止，请检查备份。');
}

export async function ensurePortFree(port:number){
  for(const host of ['0.0.0.0','::'])await new Promise<void>((resolve,reject)=>{
    const probe=net.createServer();probe.once('error',(error:NodeJS.ErrnoException)=>{if(host==='::'&&['EAFNOSUPPORT','EADDRNOTAVAIL','EPROTONOSUPPORT'].includes(error.code??''))resolve();else reject(new Error(`端口 ${port} 正在使用或无法检查。请先在业务终端按 Ctrl+C 停止服务，不会自动结束其他进程。`));});
    probe.listen({port,host,exclusive:true},()=>probe.close(error=>error?reject(error):resolve()));
  });
}
function findNpm(env:NodeJS.ProcessEnv){
  const candidates=[env.npm_execpath,path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),env.APPDATA&&path.join(env.APPDATA,'npm/node_modules/npm/bin/npm-cli.js')];
  const cli=candidates.find(p=>p&&p.endsWith('npm-cli.js')&&existsSync(p));
  if(!cli)throw new Error('找不到 npm-cli.js，请安装完整 Node.js 24，或从终端运行 npm run update:windows。');return cli;
}
async function resources(){
  const before=os.cpus().map(c=>c.times);await delay(180);const after=os.cpus().map(c=>c.times);
  let idle=0,total=0;for(let i=0;i<Math.min(before.length,after.length);i++){idle+=after[i].idle-before[i].idle;for(const key of Object.keys(after[i]) as (keyof typeof after[number])[])total+=after[i][key]-before[i][key];}
  const cpuPercent=total?Math.round((1-idle/total)*100):null;
  // macOS free 不代表 available；此处不把它误报为可用内存。热状态只在可取得时使用。
  const availableGiB=process.platform==='darwin'?null:Math.round(os.freemem()/2**30*100)/100;
  if(cpuPercent!==null&&cpuPercent>90)throw new Error('CPU 总负载超过 90%，请稍后重试更新。');
  if(availableGiB!==null&&availableGiB<1.5)throw new Error('可用内存不足 1.5GiB，请释放内存后重试更新。');
  let thermal='unavailable';
  if(process.platform==='darwin'){
    const result=spawnSync('pmset',['-g','therm'],{encoding:'utf8',timeout:3000});
    if(result.status===0){thermal=result.stdout.trim();if(thermal.split('\n').some(line=>!line.includes('No ')&&/warning level|Speed_Limit/.test(line)))throw new Error('系统报告热／性能压力，请稍后重试更新。');}
  }
  return {cpuPercent,availableGiB,thermal};
}

export async function runUpdate(options:UpdateOptions){
  const plan=updatePlan(options.root,options.env),{root,env,state,port,python}=plan;
  const backupBase=path.resolve(options.backupBase??path.join(path.dirname(root),path.basename(root)+'-backups'));
  if(inside(root,backupBase)||plan.sources.some(s=>inside(s.source,backupBase)||inside(backupBase,s.source)))throw new Error('备份位置必须独立于项目与数据源，避免递归复制或混入业务目录。');
  mkdirSync(backupBase,{recursive:true,mode:0o700});
  const runDirectory=path.join(backupBase,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  mkdirSync(runDirectory,{mode:0o700});
  const logFile=path.join(runDirectory,'update.log'),resultFile=path.join(runDirectory,'result.json');
  const secrets=Object.entries(env).filter(([key])=>secretName.test(key)).map(([,value])=>value??'');
  const stages:Stage[]=[];const releases:(()=>void)[]=[];
  const result={updaterVersion:1,platform:process.platform,osRelease:os.release(),node:process.versions.node,success:false,checkOnly:!!options.checkOnly,backupComplete:false,protectedVerified:false,beforeCommit:'',afterCommit:'',startedAt:new Date().toISOString(),finishedAt:'',failedStage:'',message:'',stages};
  function log(message:string){const line=redact(message,secrets);appendFileSync(logFile,line+'\n',{mode:0o600});if(!options.quiet)console.log(line);}
  function save(){writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n',{mode:0o600});}
  async function step<T>(name:string,action:()=>Promise<T>|T):Promise<T>{
    options.signal?.throwIfAborted();const stage:Stage={name,startedAt:new Date().toISOString(),status:'running'};stages.push(stage);log('\n['+stages.length+'] '+name);save();
    try{const value=await action();stage.status='passed';return value;}
    catch(error){stage.status='failed';result.failedStage=name;throw error;}
    finally{stage.finishedAt=new Date().toISOString();save();}
  }
  async function command(executable:string,args:string[],quiet=false){
    options.signal?.throwIfAborted();
    return await new Promise<string>((resolve,reject)=>{
      const child=spawn(executable,args,{cwd:root,env:pythonEnvironment({...env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}),stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      let output='',buffer='',errorBuffer='',failure:Error|undefined,checking=false,active=true;
      const stop=(error:Error)=>{if(failure||!active)return;failure=error;if(child.pid&&child.exitCode===null&&child.signalCode===null){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore',timeout:10000});else try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}}};
      const flush=(chunk:string,stderr=false)=>{
        if(!stderr){output+=chunk;if(output.length>4*1024*1024){stop(new Error('命令输出过多，已停止。'));return;}}
        let pending=(stderr?errorBuffer:buffer)+chunk;const lines=pending.split(/\r?\n|\r/);pending=lines.pop()??'';
        for(const line of lines)if(!quiet||stderr)log(line);
        if(pending.length>128*1024){if(!quiet||stderr)log('[单行过长，内容省略]');pending='';}
        if(stderr)errorBuffer=pending;else buffer=pending;
      };
      child.stdout.on('data',chunk=>flush(chunk));child.stderr.on('data',chunk=>flush(chunk,true));
      const timeout=setTimeout(()=>stop(new Error('单个命令超过 15 分钟，已停止；可保留备份后重试。')),15*60*1000);
      const monitor=setInterval(()=>{if(checking||failure)return;checking=true;void resources().catch(error=>stop(error as Error)).finally(()=>{checking=false;});},5000);
      const abort=()=>stop(new Error('用户取消更新，后续步骤未执行。'));options.signal?.addEventListener('abort',abort,{once:true});
      const cleanup=()=>{active=false;clearTimeout(timeout);clearInterval(monitor);options.signal?.removeEventListener('abort',abort);};
      child.once('error',error=>{cleanup();reject(new Error('无法启动所需命令：'+error.message));});
      child.once('close',code=>{
        cleanup();if(buffer&&!quiet)log(buffer);if(errorBuffer)log(errorBuffer);
        if(stages.length)stages.at(-1)!.exitCode=code??-1;
        if(failure)reject(failure);else if(code!==0)reject(new Error(`命令退出码 ${code??'未知'}，已停止后续步骤；请查看上方日志。`));else resolve(output);
      });
    });
  }
  const git=(...args:string[])=>command('git',args,true);
  async function clean(){if((await git('status','--porcelain=v1','--untracked-files=normal')).trim())throw new Error('存在本地代码改动或未跟踪文件。请先保存处理；更新器不会 reset、clean 或覆盖这些改动。');}
  try{
    log('鉴微 Windows 更新器 v1；备份与诊断目录：'+runDirectory);
    await step('预检与互斥保护',async()=>{
      if(Number(process.versions.node.split('.')[0])!==24)throw new Error('需要 Node.js 24.x，请先更新运行环境。');
      if(!existsSync(python))throw new Error('找不到本机 Python 环境，请按部署说明创建 Windows .venv；不会换用系统 Python。');
      if(canonical(await realpath((await git('rev-parse','--show-toplevel')).trim()))!==canonical(await realpath(root)))throw new Error('请在项目自身的 Git 仓库运行更新，不支持 ZIP 安装或父级仓库。');
      if((await git('branch','--show-current')).trim()!=='main')throw new Error('当前分支不是 main，请先核对部署分支。');
      await clean();result.beforeCommit=(await git('rev-parse','HEAD')).trim();
      releases.push(acquireLease(updateLeasePath(root),root));releases.push(acquireLease(stateUpdateLeasePath(state),root));
      assertLeaseFree(serviceLeasePath(state));await ensurePortFree(port);
      const info=JSON.parse(await command(python,['-c','import sys,json; print(json.dumps({"venv":sys.prefix!=sys.base_prefix,"version":list(sys.version_info[:3])}))'],true));
      if(!info.venv)throw new Error('更新器只在 Python 虚拟环境内安装依赖，请将 SV_VISION_PYTHON 指向本机 .venv 或其他虚拟环境。');
      log('Python '+info.version.join('.'));log('资源检查：'+JSON.stringify(await resources()));findNpm(env);
    });
    if(options.checkOnly){result.success=true;result.message='预检通过。未备份、拉取代码、安装依赖或构建。';return Object.assign(result,{runDirectory});}
    const entries=await step('扫描备份源及磁盘空间',async()=>{
      const entries=await inventory(plan.sources),bytes=entries.reduce((total,e)=>total+e.bytes,0),disk=statfsSync(runDirectory);
      if(Number(disk.bavail)*Number(disk.bsize)<bytes*1.1+64*1024*1024)throw new Error('备份磁盘剩余空间不足，尚未更新代码。');
      log(`将备份 ${entries.length} 个文件、${Math.ceil(bytes/1024/1024)} MiB；包含原图、SQLite 与私有配置。`);return entries;
    });
    const saved=await step('完整复制并逐文件校验 SHA-256',async()=>{
      const saved:Saved[]=[];let resourceAt=Date.now();
      for(const entry of entries){options.signal?.throwIfAborted();if(Date.now()-resourceAt>5000){log('备份资源检查：'+JSON.stringify(await resources()));resourceAt=Date.now();}const destination=path.join(runDirectory,'private-backup',entry.destination);mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});await copyFile(entry.source,destination);const digest=await hash(entry.source);if(digest!==await hash(destination))throw new Error('备份校验失败，尚未更新代码。');const after=await stat(entry.source);if(after.size!==entry.bytes||after.mtimeMs!==entry.mtimeMs)throw new Error('备份时源文件发生修改，请先停止业务服务。');saved.push({...entry,sha256:digest});}
      await verifySources(saved,plan.sources);
      writeFileSync(path.join(runDirectory,'private-backup','manifest.json'),JSON.stringify({version:1,commit:result.beforeCommit,root,state,account:plan.account,files:saved},null,2)+'\n',{mode:0o600});
      result.backupComplete=true;log('备份已完成且校验通过。私有备份含账号及配置，请勿作为报错附件发送。');return saved;
    });
    await step('获取 origin/main 并检查安全边界',async()=>{
      await git('fetch','--no-tags','origin','main');result.afterCommit=(await git('rev-parse','FETCH_HEAD')).trim();
      try{await git('merge-base','--is-ancestor',result.beforeCommit,result.afterCommit);}catch{throw new Error('本地与远端历史不能快进合并，请保留本地提交并人工处理；未重置或合并代码。');}
      const protectedPaths=[plan.configFile,path.join(root,'var'),state,plan.account];
      const files=(await git('ls-tree','-r','-z','--name-only',result.afterCommit)).split('\0').filter(Boolean);
      if(files.some(file=>protectedPaths.some(protectedPath=>inside(protectedPath,path.resolve(root,file)))))throw new Error('目标版本包含受保护的数据或私有配置路径，拒绝覆盖。');
      if((await git('rev-parse','HEAD')).trim()!==result.beforeCommit)throw new Error('期间 Git 版本被其他操作更改，已停止。');await clean();
      assertLeaseFree(serviceLeasePath(state));await ensurePortFree(port);await verifySources(saved,plan.sources);
    });
    await step('快进更新代码',async()=>{await git('merge','--ff-only',result.afterCommit);await verifySources(saved,plan.sources);});
    let allowed:{file:string;sha256:string}|undefined;
    await step('确认配置与依赖环境',async()=>{
      if(plan.repairPython){
        const text=readFileSync(plan.configFile,'utf8').replace(/^(\s*(?:export\s+)?SV_VISION_PYTHON\s*=).*$/gm,'$1./.venv/Scripts/python.exe');
        writeFileSync(plan.configFile,text,{mode:0o600});allowed={file:plan.configFile,sha256:await hash(plan.configFile)};
        log('已将旧 macOS 默认解释器路径调整为 Windows 路径；原配置已备份，其余配置保持原值。');
      }
      env.SV_VISION_PYTHON=python;log('资源检查：'+JSON.stringify(await resources()));
    });
    const npm=findNpm(env);
    await step('安装 Node 依赖',()=>command(process.execPath,[npm,'ci','--include=dev','--no-audit','--no-fund']));
    await step('安装 Python 依赖',async()=>{
      const available=(await command(python,['-c','import importlib.util; print("yes" if importlib.util.find_spec("pip") else "no")'],true)).trim();
      if(available==='no'){log('虚拟环境缺少 pip，使用 Python 自带 ensurepip 离线补齐。');await command(python,['-m','ensurepip','--upgrade']);}
      await command(python,['-m','pip','install','--disable-pip-version-check','--no-input','-r',path.join(root,'requirements.txt')]);
    });
    await step('检查 TypeScript',()=>command(process.execPath,[npm,'run','check']));
    await step('构建前端',()=>command(process.execPath,[npm,'run','build']));
    await step('核对数据与配置未被改写',async()=>{await verifySources(saved,plan.sources,allowed);result.protectedVerified=true;log('原正品、图片、账号文件与数据库校验通过。');});
    result.success=true;result.message='更新完成。请按原方式启动业务服务，并用原账号核对正品。';return Object.assign(result,{runDirectory});
  }catch(error){result.message=(result.failedStage?'['+result.failedStage+'] ':'')+redact(error instanceof Error?error.message:String(error),secrets);throw Object.assign(new Error(result.message),{runDirectory});}
  finally{
    result.finishedAt=new Date().toISOString();save();log(result.success?result.message:'更新已停止：'+result.message);
    if(!result.success)log('不会自动回滚或启动业务服务。备份完整状态：'+result.backupComplete+'；请发送 update.log 和 result.json 排查，不发送 private-backup。');
    for(const release of releases.reverse())release();
  }
}

async function main(){
  if(process.platform!=='win32')throw new Error('此一键入口用于 Windows；其他系统请使用部署说明中的手工步骤。');
  const args=process.argv.slice(2);let checkOnly=false,backupBase:string|undefined;
  for(let i=0;i<args.length;i++){if(args[i]==='--check')checkOnly=true;else if(args[i]==='--backup-dir'&&args[i+1])backupBase=args[++i];else throw new Error('用法：update-windows.cmd [--check] [--backup-dir "D:/备份目录"]');}
  const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{await runUpdate({root:fileURLToPath(new URL('../',import.meta.url)),backupBase,checkOnly,signal:controller.signal});}finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)void main().catch(error=>{
  const message=redact(error.message,Object.entries(process.env).filter(([key])=>secretName.test(key)).map(([,value])=>value??''));
  let directory=error.runDirectory;
  if(!directory){directory=path.join(os.tmpdir(),'jianwei-update-error-'+randomUUID());try{mkdirSync(directory,{mode:0o700});writeFileSync(path.join(directory,'update.log'),'预检失败：'+message+'\n',{mode:0o600});writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:false,backupComplete:false,failedStage:'初始化预检',message},null,2),{mode:0o600});}catch{directory=undefined;}}
  console.error('更新失败：'+message);if(directory)console.error('诊断目录：'+directory);process.exitCode=1;
});

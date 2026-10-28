import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pythonExecutable, pythonEnvironment } from '../python-runtime.ts';
import { prepareImport, refreshImport } from './imports.ts';
import { ApiError } from '../errors.ts';
import type { ReferenceAnalyses } from './analysis.ts';
import type { Registry } from './registry.ts';
import type { Person } from '../../shared/types.ts';
import type { ReferenceAsset, ImportJob, ImportRow } from '../../shared/admin.ts';

export class AdminFiles {
  registry:Registry;root:string;directory:string;analyses?:ReferenceAnalyses;busy=false;children=new Set<ReturnType<typeof spawn>>();
  constructor(registry:Registry,root:string,directory:string,analyses?:ReferenceAnalyses){this.analyses=analyses;this.registry=registry;this.root=root;this.directory=directory;
    for(const row of registry.store.db.prepare('SELECT owner,data FROM reference_imports').all()){
      const job:ImportJob=JSON.parse(String(row.data));if(job.status==='validating'){job.status='failed';job.message='服务已重启，请重新上传预检。';registry.saveJob(job,String(row.owner));}
    }
  }
  async worker(script:string,input:unknown,timeout=120000):Promise<any>{
    return await new Promise((resolve,reject)=>{const child=spawn(script.endsWith('.ts')?process.execPath:pythonExecutable(this.root),[...(script.endsWith('.ts')?['--max-old-space-size=1024']:[]),path.join(this.root,'server/admin',script)],{cwd:this.root,stdio:['pipe','pipe','pipe'],env:pythonEnvironment()});this.children.add(child);
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      let out='',err='',done=false;const finish=(e?:Error,data?:unknown)=>{if(done)return;done=true;clearTimeout(timer);this.children.delete(child);e?reject(e):resolve(data);};
      const timer=setTimeout(()=>{child.kill();finish(new ApiError(503,'图片预检超时，已保留录入内容，请拆小批次重试。'));},timeout);
      child.on('error',()=>finish(new ApiError(503,'图片处理环境未安装，请按部署说明安装 Python 依赖。')));child.stdin.on('error',()=>{});
      child.stdout.on('data',b=>{out+=b;if(out.length>16*1024*1024){child.kill();finish(new ApiError(413,'预检结果过大，请拆分批次。'));}});child.stderr.on('data',b=>{err=(err+b).slice(-1000);});
      child.on('close',code=>{try{const data=JSON.parse(out);if(code||data.error)finish(new ApiError(400,data.error??'图片处理失败。'));else finish(undefined,data);}catch{console.error('正品图片预检异常',err);finish(new ApiError(503,'图片预检未完成，请检查依赖后重试。'));}});child.stdin.end(JSON.stringify(input));
    });
  }
  async upload(file:File){if(this.busy)throw new ApiError(429,'正在预检其他图片，请稍后重试。');this.busy=true;const dir=path.join(this.directory,'admin-staging',randomUUID());
    try{if(file.size>20*1024*1024)throw new ApiError(413,'单张图片最多 20MB。');await mkdir(dir,{recursive:true,mode:0o700});const source=path.join(dir,'source');await writeFile(source,new Uint8Array(await file.arrayBuffer()),{mode:0o600});const asset:ReferenceAsset=await this.worker('asset_worker.py',{source,filename:file.name,folder:path.join(this.directory,'files')},20000);this.registry.addAsset(asset);return {...asset,...(this.analyses?{analysisId:this.analyses.start(asset.id,[],true).id}:{})};}finally{this.busy=false;await rm(dir,{recursive:true,force:true});}
  }
  async edit(id:string,input:{angle:number;crop?:{x:number;y:number;width:number;height:number}}){
    if(this.busy)throw new ApiError(429,'正在处理其他图片，请稍后重试。');
    const original=this.registry.asset(id);if(!original)throw new ApiError(404,'正品图片不存在。');
    this.busy=true;try{const edited:ReferenceAsset=await this.worker('edit_worker.py',{...input,source:path.join(this.directory,'files',id),filename:original.filename,folder:path.join(this.directory,'files')},30000);edited.originalId=original.originalId??original.id;this.registry.addAsset(edited);return {...edited,...(this.analyses?{analysisId:this.analyses.start(edited.id,[],true).id}:{})};}finally{this.busy=false;}
  }
  async start(files:File[],actor:Person){
    if(this.busy)throw new ApiError(429,'正在处理另一批图片，请稍后再试。');if(!files.length||files.length>2001||files.reduce((n,f)=>n+f.size,0)>200*1024*1024)throw new ApiError(413,'每批总大小最多 200MB、最多 2000 条标准。');
    this.busy=true;const id=randomUUID(),dir=path.join(this.directory,'admin-staging',id);
    const job:ImportJob={id,status:'validating',filename:files[0].name,rows:[],message:'正在检查清单、图片与重复项，随后自动分析正品。',counts:{ready:0,skip:0,error:0},createdAt:new Date().toISOString()};
    try{await mkdir(dir,{recursive:true,mode:0o700});const saved=[];for(let i=0;i<files.length;i++){const target=path.join(dir,String(i));await writeFile(target,new Uint8Array(await files[i].arrayBuffer()),{mode:0o600});saved.push({name:files[i].name,path:target});}this.registry.saveJob(job,actor.id);
      void (async()=>{let imported=saved,archiveFiles=false;if(saved.length===1&&/\.rar$/i.test(saved[0].name)){const result=await this.worker('rar_worker.ts',{root:this.root,source:saved[0].path,folder:path.join(dir,'rar')},60000);imported=result.files;archiveFiles=true;}return this.worker('import_worker.py',{files:imported,archiveFiles,folder:path.join(this.directory,'files')},300000);})().then((result:{rows:ImportRow[];assets:ReferenceAsset[]})=>{for(const a of result.assets)this.registry.addAsset(a);job.rows=result.rows;for(const row of job.rows)row.manualContent=!!(row.lines.length||row.description);prepareImport(this.registry,job);for(const row of job.rows)if(row.assetId&&this.analyses){const a=this.analyses.start(row.assetId);row.analysisId=a.id;row.analysis=a;if(a.result&&!row.manualContent){row.lines=a.result.lines;row.description=a.result.description;}}refreshImport(job);this.registry.saveJob(job,actor.id);}).catch(e=>{job.status='failed';job.message=(e as Error).message;this.registry.saveJob(job,actor.id);}).finally(async()=>{this.busy=false;await rm(dir,{recursive:true,force:true});});return job;
    }catch(e){this.busy=false;await rm(dir,{recursive:true,force:true});throw e;}
  }
  close(){this.analyses?.close();for(const child of this.children)child.kill();}
}

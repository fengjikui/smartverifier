import type http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import type { InspectionService } from '../service.ts';
import { ApiError } from '../errors.ts';
import { prepareImport, refreshImport } from './imports.ts';
import { ReferenceAnalyses } from './analysis.ts';
import type { ReferenceAnalyzer } from './analysis.ts';
import { LocalVisionPipeline } from '../vision/local-pipeline.ts';
import { analyzeReference } from '../vision/reference-analysis.ts';
import { referenceInput, regionSchema } from './registry.ts';
import { AdminFiles } from './files.ts';
import { AdminAuth } from './auth.ts';
import { readAdminAccess } from './access-config.ts';
import { accountName } from './accounts.ts';
import { accountPassword } from './password.ts';

type Helpers={body:(req:http.IncomingMessage,max?:number)=>Promise<Buffer>;json:(req:http.IncomingMessage)=>Promise<Record<string,unknown>>;send:(res:http.ServerResponse,data:unknown,status?:number)=>void;file:(res:http.ServerResponse,path:string,priv?:boolean)=>Promise<void>};
const paging=z.coerce.number().int().min(1).max(100000).default(1);
export function adminRoutes(service:InspectionService,root:string,directory:string,helpers:Helpers,analyzer?:ReferenceAnalyzer){
  const registry=service.registry,auth=new AdminAuth(service.store,readAdminAccess(process.env,root)),analyses=new ReferenceAnalyses(registry,analyzer??(service.vision instanceof LocalVisionPipeline?((asset,regions,onStarted)=>analyzeReference(service.vision as LocalVisionPipeline,asset,regions,onStarted)):undefined),service.vision?.model),files=new AdminFiles(registry,root,directory,analyses),{body,json,send,file}=helpers;
  let reading=false;
  async function form(req:http.IncomingMessage,max:number){if(reading){req.resume();throw new ApiError(429,'正在接收其他文件，请稍后重试。');}reading=true;try{if(!req.headers['content-type']?.startsWith('multipart/form-data;'))throw new ApiError(415,'请选择要上传的文件。');const bytes=await body(req,max);return await new Request('http://localhost',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:new Uint8Array(bytes)}).formData();}finally{reading=false;}}
  return {auth,files,analyses,async handle(req:http.IncomingMessage,res:http.ServerResponse,url:URL,inspector:boolean){const p=decodeURIComponent(url.pathname),method=req.method;
    const image=p.match(/^\/reference-assets\/([a-f0-9-]+(?:-thumb)?\.(?:png|jpg|webp))$/);
    if(image&&method==='GET'){
      if(!inspector&&!auth.current(req))throw new ApiError(401,'请先登录后查看正品图片。');
      if(!registry.asset(image[1])&&!/^[a-f0-9-]+-thumb\.jpg$/.test(image[1]))throw new ApiError(404,'正品图片不存在。');
      if(image[1].includes('-thumb')&&!registry.store.db.prepare('SELECT id FROM reference_assets WHERE id LIKE ? LIMIT 1').get(image[1].split('-thumb')[0]+'.%'))throw new ApiError(404,'图片不存在。');
      await file(res,path.join(directory,'files',image[1]),true);return true;
    }
    if(!p.startsWith('/admin/'))return false;
    if(p==='/admin/config'&&method==='GET'){send(res,auth.publicConfig());return true;}
    if(p==='/admin/session'&&method==='POST'){const input=z.object({id:z.string().max(80),name:z.string().max(80).optional(),code:z.string().max(256).optional()}).strict().parse(await json(req));send(res,await auth.login(req,res,input));return true;}
    const actor=auth.require(req);
    if(p==='/admin/session'&&method==='GET'){send(res,auth.current(req));return true;}
    if(p==='/admin/session'&&method==='DELETE'){auth.logout(req,res);send(res,{ok:true});return true;}
    if(p==='/admin/users'||p.startsWith('/admin/users/')||p==='/admin/access-events'){
      auth.requireOwner(req);
      const authorize=()=>auth.requireOwner(req),version=z.number().int().positive();
      if(p==='/admin/users'&&method==='GET'){send(res,auth.accounts.page(z.string().max(160).parse(url.searchParams.get('q')??''),z.enum(['all','active','disabled']).parse(url.searchParams.get('status')??'all'),paging.parse(url.searchParams.get('page')??1)));return true;}
      if(p==='/admin/users'&&method==='POST'){send(res,await auth.accounts.create(await json(req),authorize),201);return true;}
      if(p==='/admin/access-events'&&method==='GET'){send(res,auth.accounts.events(z.string().max(160).parse(url.searchParams.get('q')??''),paging.parse(url.searchParams.get('page')??1)));return true;}
      const target=p.match(/^\/admin\/users\/([A-Za-z0-9_.@-]{1,80})(?:\/(status|password))?$/);
      if(target&&method==='POST'&&target[2]==='status'){const input=z.object({version,status:z.enum(['active','disabled']),reason:z.string().trim().min(1).max(500)}).strict().parse(await json(req));send(res,auth.accounts.status(target[1],input.version,input.status,input.reason,authorize));return true;}
      if(target&&method==='POST'&&target[2]==='password'){const input=z.object({version,password:accountPassword}).strict().parse(await json(req));send(res,await auth.accounts.resetPassword(target[1],input.version,input.password,authorize));return true;}
      if(target&&method==='PUT'&&!target[2]){const input=z.object({version,name:accountName}).strict().parse(await json(req));send(res,auth.accounts.rename(target[1],input.version,input.name,authorize));return true;}
      throw new ApiError(405,'人员管理不支持此操作；系统负责人账号仅由服务器端配置。');
    }
    if(p==='/admin/analyses'&&method==='POST'){const input=z.object({assetId:z.string().max(100),regions:z.array(regionSchema).max(30).default([]),fresh:z.boolean().default(false)}).strict().parse(await json(req));referenceInput.parse({material:'analysis',modelNumber:'analysis',status:'draft',regions:input.regions});send(res,analyses.start(input.assetId,input.regions,input.fresh),202);return true;}
    const analysis=p.match(/^\/admin\/analyses\/([a-f0-9-]{36})$/);if(analysis&&method==='GET'){const result=registry.analysis(analysis[1]);if(!result)throw new ApiError(404,'分析记录不存在。');send(res,result);return true;}
    if(p==='/admin/assets'&&method==='POST'){const data=await form(req,22*1024*1024),image=data.get('image');if(!(image instanceof File))throw new ApiError(400,'请选择正品图片。');send(res,await files.upload(image),201);return true;}
    const assetInfo=p.match(/^\/admin\/assets\/([a-f0-9-]+\.(?:png|jpg|webp))$/);
    if(assetInfo&&method==='GET'){const asset=registry.asset(assetInfo[1]);if(!asset)throw new ApiError(404,'正品图片不存在。');send(res,asset);return true;}
    const editAsset=p.match(/^\/admin\/assets\/([a-f0-9-]+\.(?:png|jpg|webp))\/edit$/);
    if(editAsset&&method==='POST'){const input=z.object({regions:z.array(regionSchema).max(30).default([]),angle:z.number().min(-180).max(180),crop:z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1)}).optional()}).strict().parse(await json(req));referenceInput.parse({status:'draft',material:'edit',regions:input.regions});send(res,await files.edit(editAsset[1],input),201);return true;}
    if(p==='/admin/standards'&&method==='GET'){const q=z.string().max(200).parse(url.searchParams.get('q')??''),status=z.enum(['all','active','draft','trash','pending','quality','ambiguity','override']).parse(url.searchParams.get('status')??'all'),page=paging.parse(url.searchParams.get('page')??1),size=z.coerce.number().int().min(1).max(50).parse(url.searchParams.get('size')??25);send(res,registry.page(q,status,page,size));return true;}
    if(p==='/admin/standards'&&method==='POST'){send(res,registry.save(await json(req),actor),201);return true;}
    const record=p.match(/^\/admin\/standards\/([a-f0-9-]{36})(?:\/(trash|restore))?$/);
    if(record){const [,id,action]=record;if(!action&&method==='GET'){send(res,registry.detail(id));return true;}if(!action&&method==='PUT'){const {version,...input}=await json(req);send(res,registry.save(input,actor,id,z.number().int().positive().parse(version)));return true;}if(action&&method==='POST'){const {version}=z.object({version:z.number().int().positive()}).parse(await json(req));send(res,registry.trash(id,version,action==='restore',actor));return true;}}
    if(p==='/admin/audit-logs'&&method==='GET'){send(res,registry.events(z.string().max(200).parse(url.searchParams.get('q')??''),paging.parse(url.searchParams.get('page')??1)));return true;}
    if((p==='/admin/tasks'||/^\/admin\/tasks\/[^/]+$/.test(p))&&method!=='GET'){
      req.resume();throw new ApiError(405,'检验任务由 MES 同步，本系统不提供新增、修改或删除任务的接口。');
    }
    if(p==='/admin/imports'&&method==='POST'){const data=await form(req,202*1024*1024),uploads=data.getAll('files').filter((f):f is File=>f instanceof File);send(res,await files.start(uploads,actor),202);return true;}
    if(p==='/admin/imports'&&method==='GET'){send(res,registry.jobs(actor.id));return true;}
    const importRow=p.match(/^\/admin\/imports\/([a-f0-9-]{36})\/rows\/(\d+)$/);
    if(importRow&&method==='PUT'){const {version,...raw}=await json(req),input=referenceInput.parse(raw),job=registry.job(importRow[1],actor.id);if(job.status!=='preview'||job.version!==z.number().int().positive().parse(version))throw new ApiError(409,'批次已更新，请返回预览后重新打开；当前输入仍保留。');const row=job.rows.find(r=>r.row===Number(importRow[2]));if(!row||row.savedId)throw new ApiError(409,'条目不存在或已经保存。');if(!registry.asset(input.assetId))throw new ApiError(400,'请补充有效图片。');const previous=structuredClone(job.rows),manualContent=row.assetId===input.assetId?(!!row.manualContent||JSON.stringify(row.lines)!==JSON.stringify(input.lines)||row.description!==input.description):!!(input.lines.length||input.description);Object.assign(row,input,{manualContent,status:input.material&&input.modelNumber?'ready':'error',message:input.material&&input.modelNumber?'资料已更新':'请补齐物料编号与型号',savedId:undefined});const a=analyses.start(input.assetId,input.regions);row.analysisId=a.id;row.analysis=a;prepareImport(registry,job);for(const item of job.rows){const old=previous.find(r=>r.row===item.row);if(item!==row&&old&&old.material===item.material&&old.modelNumber===item.modelNumber&&old.batchGroup===item.batchGroup&&old.duplicateId===item.duplicateId)item.decision=old.decision;}row.analysisId=a.id;row.analysis=a;job.version=(Number(version))+1;refreshImport(job);registry.saveJob(job,actor.id);registry.event('import-row',job.id,'import.row.update',actor,previous.find(r=>r.row===row.row),row);send(res,job);return true;}
    const choices=p.match(/^\/admin\/imports\/([a-f0-9-]{36})\/choices$/);
    if(choices&&method==='PUT'){const input=z.object({version:z.number().int().positive(),rows:z.array(z.number().int().positive()).min(1).max(2000),decision:z.enum(['include','defer'])}).strict().parse(await json(req));send(res,registry.decideJob(choices[1],actor,input.version,input.rows,input.decision));return true;}
    const job=p.match(/^\/admin\/imports\/([a-f0-9-]{36})(?:\/(commit))?$/);
    if(job){if(method==='GET'&&!job[2]){send(res,registry.job(job[1],actor.id));return true;}if(method==='POST'&&job[2]){const input=z.object({version:z.number().int().positive().optional()}).strict().parse(await json(req));send(res,registry.commitJob(job[1],actor,input.version));return true;}}
    const template=p.match(/^\/admin\/templates\/(xlsx|json|zip|help|filenames)$/);
    if(template&&method==='GET'){const names:Record<string,string>={xlsx:'正品标准导入模板.xlsx',json:'standards.json',zip:'JSON标准包示例.zip',help:'填写说明.txt',filenames:'图片命名示例.zip'};res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(names[template[1]])}`);await file(res,path.join(root,'templates/reference-import-v1',names[template[1]]),true);return true;}
    throw new ApiError(404,'管理接口不存在。');
  }};
}

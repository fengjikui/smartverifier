import type http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import type { InspectionService } from '../service.ts';
import { ApiError } from '../errors.ts';
import { AdminFiles } from './files.ts';
import { AdminAuth } from './auth.ts';

type Helpers={body:(req:http.IncomingMessage,max?:number)=>Promise<Buffer>;json:(req:http.IncomingMessage)=>Promise<Record<string,unknown>>;send:(res:http.ServerResponse,data:unknown,status?:number)=>void;file:(res:http.ServerResponse,path:string,priv?:boolean)=>Promise<void>};
const paging=z.coerce.number().int().min(1).max(100000).default(1);
export function adminRoutes(service:InspectionService,root:string,directory:string,helpers:Helpers){
  const registry=service.registry,auth=new AdminAuth(service.store),files=new AdminFiles(registry,root,directory),{body,json,send,file}=helpers;
  let reading=false;
  async function form(req:http.IncomingMessage,max:number){if(reading){req.resume();throw new ApiError(429,'正在接收其他文件，请稍后重试。');}reading=true;try{if(!req.headers['content-type']?.startsWith('multipart/form-data;'))throw new ApiError(415,'请选择要上传的文件。');const bytes=await body(req,max);return await new Request('http://localhost',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:new Uint8Array(bytes)}).formData();}finally{reading=false;}}
  return {auth,files,async handle(req:http.IncomingMessage,res:http.ServerResponse,url:URL,inspector:boolean){const p=decodeURIComponent(url.pathname),method=req.method;
    const image=p.match(/^\/api\/reference-assets\/([a-f0-9-]+(?:-thumb)?\.(?:png|jpg|webp))$/);
    if(image&&method==='GET'){
      if(!inspector&&!auth.current(req))throw new ApiError(401,'请先登录后查看正品图片。');
      if(!registry.asset(image[1])&&!/^[a-f0-9-]+-thumb\.jpg$/.test(image[1]))throw new ApiError(404,'正品图片不存在。');
      if(image[1].includes('-thumb')&&!registry.store.db.prepare('SELECT id FROM reference_assets WHERE id LIKE ? LIMIT 1').get(image[1].split('-thumb')[0]+'.%'))throw new ApiError(404,'图片不存在。');
      await file(res,path.join(directory,'files',image[1]),true);return true;
    }
    if(!p.startsWith('/api/admin/'))return false;
    if(p==='/api/admin/config'&&method==='GET'){send(res,{accessMode:process.env.SV_ADMIN_USERS_FILE?'access-code':'loopback'});return true;}
    if(p==='/api/admin/session'&&method==='POST'){const input=z.object({id:z.string().max(80),name:z.string().max(80).optional(),code:z.string().max(256).optional()}).strict().parse(await json(req));send(res,auth.login(req,res,input));return true;}
    const actor=auth.require(req);
    if(p==='/api/admin/session'&&method==='GET'){send(res,auth.current(req));return true;}
    if(p==='/api/admin/session'&&method==='DELETE'){auth.logout(req,res);send(res,{ok:true});return true;}
    if(p==='/api/admin/assets'&&method==='POST'){const data=await form(req,22*1024*1024),image=data.get('image');if(!(image instanceof File))throw new ApiError(400,'请选择正品图片。');send(res,await files.upload(image),201);return true;}
    if(p==='/api/admin/references'&&method==='GET'){const q=z.string().max(200).parse(url.searchParams.get('q')??''),status=z.enum(['all','active','draft','trash']).parse(url.searchParams.get('status')??'all'),page=paging.parse(url.searchParams.get('page')??1),size=z.coerce.number().int().min(1).max(50).parse(url.searchParams.get('size')??25);send(res,registry.page(q,status,page,size));return true;}
    if(p==='/api/admin/references'&&method==='POST'){send(res,registry.save(await json(req),actor),201);return true;}
    const record=p.match(/^\/api\/admin\/references\/([a-f0-9-]{36})(?:\/(trash|restore))?$/);
    if(record){const [,id,action]=record;if(!action&&method==='GET'){send(res,registry.detail(id));return true;}if(!action&&method==='PUT'){const {version,...input}=await json(req);send(res,registry.save(input,actor,id,z.number().int().positive().parse(version)));return true;}if(action&&method==='POST'){const {version}=z.object({version:z.number().int().positive()}).parse(await json(req));send(res,registry.trash(id,version,action==='restore',actor));return true;}}
    if(p==='/api/admin/events'&&method==='GET'){send(res,registry.events(z.string().max(200).parse(url.searchParams.get('q')??''),paging.parse(url.searchParams.get('page')??1)));return true;}
    if(p==='/api/admin/tasks'&&method==='GET'){send(res,{items:service.list()});return true;}
    if((p==='/api/admin/tasks'||/^\/api\/admin\/tasks\/[^/]+$/.test(p))&&method!=='GET'){
      req.resume();throw new ApiError(405,'检验任务由 MES 同步，本系统不提供新增、修改或删除任务的接口。');
    }
    if(p==='/api/admin/imports'&&method==='POST'){const data=await form(req,202*1024*1024),uploads=data.getAll('files').filter((f):f is File=>f instanceof File);send(res,await files.start(uploads,actor),202);return true;}
    const job=p.match(/^\/api\/admin\/imports\/([a-f0-9-]{36})(?:\/(commit))?$/);
    if(job){if(method==='GET'&&!job[2]){send(res,registry.job(job[1],actor.id));return true;}if(method==='POST'&&job[2]){await json(req);send(res,registry.commitJob(job[1],actor));return true;}}
    const template=p.match(/^\/api\/admin\/templates\/(xlsx|json|zip|help)$/);
    if(template&&method==='GET'){const names:Record<string,string>={xlsx:'正品标准导入模板.xlsx',json:'standards.json',zip:'JSON标准包示例.zip',help:'填写说明.txt'};res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(names[template[1]])}`);await file(res,path.join(root,'next/templates/reference-import-v1',names[template[1]]),true);return true;}
    throw new ApiError(404,'管理接口不存在。');
  }};
}

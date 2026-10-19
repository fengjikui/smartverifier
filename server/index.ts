import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError, InspectionService, person } from './service.ts';
import { LocalVisionPipeline } from './vision/local-pipeline.ts';
import type { VisionPipeline } from './vision/local-pipeline.ts';
import { TraceStore } from './vision/trace-store.ts';
import { adminRoutes } from './admin/http.ts';
import { DebugRuns } from './vision/debug-runs.ts';
import { directLoopback } from './network.ts';
import { MARKING_BASE, MARKING_API, canonicalPage, apiRoute, publicLinkReplacer } from '../shared/paths.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const revisionSchema = z.number().int().positive();
const mime: Record<string,string> = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.woff2':'font/woff2', '.md':'text/markdown; charset=utf-8', '.json':'application/json; charset=utf-8' };
async function body(req: http.IncomingMessage, max = 128 * 1024) {
  if (Number(req.headers['content-length'] ?? 0) > max) { req.resume(); throw new ApiError(413,'上传内容过大，单张照片最多20MB。'); }
  const chunks: Buffer[] = []; let length=0;
  for await (const chunk of req) { length += chunk.length; if (length > max) throw new ApiError(413,'上传内容过大。'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function jsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415,'请求需要JSON格式。');
  try { const data=JSON.parse((await body(req)).toString()); if (!data || typeof data!=='object' || Array.isArray(data)) throw new Error(); return data; } catch(e) { if(e instanceof ApiError)throw e; throw new ApiError(400,'请求内容不是有效的JSON对象。'); }
}
function send(res: http.ServerResponse, data: unknown, status=200) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data,publicLinkReplacer)); }
async function file(res: http.ServerResponse, filename: string, privateFile=false) {
  let info; try { info=await stat(filename); } catch { throw new ApiError(404,'文件不存在。'); }
  if (!info.isFile()) throw new ApiError(404,'文件不存在。');
  res.writeHead(200, {'Content-Type':mime[path.extname(filename)] ?? 'application/octet-stream','Content-Length':info.size,'Cache-Control':privateFile?'private, no-store':'no-cache'});
  const stream=createReadStream(filename); stream.on('error',()=>res.destroy()); stream.pipe(res);
}

export function startServer(options: { state?: string; port?: number; host?: string; delay?: number; vision?:VisionPipeline; real?:boolean;debug?:boolean } = {}) {
  const state=path.resolve(options.state ?? process.env.SV_STATE_DIR ?? path.join(root,'var/data'));
  const staticDir=path.join(root,'dist');
  const debug=options.debug??process.env.SV_MODEL_DEBUG==='1',traces=new TraceStore(path.join(state,'vision-traces'));
  const vision=options.vision??((options.real??['vlm','lmstudio'].includes(process.env.SV_RECOGNIZER??''))?new LocalVisionPipeline(root,state,debug?{traceDirectory:traces.directory}:{}):undefined);
  const debugRuns=debug&&vision instanceof LocalVisionPipeline?new DebugRuns(vision,traces):undefined;
  const recognition=vision?{mode:'vlm' as const,model:vision.model,...(vision instanceof LocalVisionPipeline?{provider:vision.provider}:{})}:{mode:'mock' as const};
  const service=new InspectionService(state,root,options.delay ?? Number(process.env.SV_MOCK_DELAY_MS ?? 1200),vision);
  const admin=adminRoutes(service,root,state,{body,json:jsonBody,send,file});
  let uploads=0;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('X-Frame-Options','SAMEORIGIN');
    try {
      const url=new URL(req.url ?? '/', 'http://localhost');
      const incoming=decodeURIComponent(url.pathname),api=apiRoute(incoming),canonical=canonicalPage(incoming);
      if(api===null){
        if(!canonical)throw new ApiError(404,'页面不存在，请使用新的丝印检测入口。');
        if(canonical!==incoming&&['GET','HEAD'].includes(req.method??'')){
          res.writeHead(308,{Location:canonical+url.search,'Cache-Control':'no-store'});return res.end();
        }
      }else url.pathname=api;
      const pathname=api??incoming;
      if (req.method!=='GET'&&req.method!=='HEAD') {
        const origin=req.headers.origin;
        if (origin && !['http://'+req.headers.host,'https://'+req.headers.host].includes(origin)) throw new ApiError(403,'请从本应用页面发起操作。');
      }
      if(pathname==='/health'&&req.method==='GET')return send(res,{ok:true,mode:'mock',recognition,schemaVersion:1,modelDebug:debug,...(vision instanceof LocalVisionPipeline?{visionConfiguration:{inputLayout:vision.inputLayout,outputFormat:vision.structured?'json-schema':'prompt-json'}}:{})});
      const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('sv_next_session='))?.slice('sv_next_session='.length);
      const session=token?service.store.db.prepare('SELECT person,expires FROM sessions WHERE token=?').get(token):null;
      if(await admin.handle(req,res,url,!!session&&Number(session.expires)>Date.now()))return;
      if(pathname==='/session'&&req.method==='POST'){
        await jsonBody(req); const key=randomBytes(32).toString('hex');
        service.store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
        service.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(key,JSON.stringify(person),Date.now()+24*60*60*1000);
        res.setHeader('Set-Cookie',`sv_next_session=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
        return send(res,{person,mode:'mock',recognition,tasks:service.list()});
      }
      if(api!==null){
        if(!session||Number(session.expires)<Date.now())throw new ApiError(401,'本地试用会话已过期，请重新进入，草稿已保留。');
        const actor=JSON.parse(String(session.person));
        if(pathname.startsWith('/debug/')){
          if(!debug)throw new ApiError(404,'本服务未启用模型调试窗口。');
          if(!directLoopback(req))throw new ApiError(403,'模型调试只允许在服务器本机直接查看。');
          if(pathname==='/debug/traces'&&req.method==='GET')return send(res,{traces:await traces.list(),running:debugRuns?.running??false});
          if(pathname==='/debug/samples'&&req.method==='POST'){
            if(!debugRuns)throw new ApiError(409,'此服务没有配置可调用的VLM。');
            if(service.worker||debugRuns.running)throw new ApiError(409,'当前有识别正在执行，请完成后再试，调试不会抢占检验任务。');
            const input=z.object({mode:z.enum(['single','board4','board6']),format:z.enum(['prompt-json','json-schema']),inputLayout:z.enum(['legacy','prefix-first']).default('prefix-first')}).strict().parse(await jsonBody(req));
            return send(res,{id:debugRuns.start(input.mode,input.format,actor.id,input.inputLayout)},202);
          }
          const image=pathname.match(/^\/debug\/traces\/([a-f0-9-]{36})\/images\/([0-9])\.png$/);
          if(image&&req.method==='GET')return await file(res,path.join(traces.folder(image[1]),'image-'+image[2]+'.png'),true);
          const trace=pathname.match(/^\/debug\/traces\/([a-f0-9-]{36})$/);
          if(trace&&req.method==='GET'){
            const after=z.coerce.number().int().nonnegative().parse(url.searchParams.get('after')??'0');
            let events;try{events=await traces.read(trace[1]);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'记录正在创建，稍后自动重试。');throw e;}
            return send(res,{events:events.filter(e=>e.seq>after),next:events.at(-1)?.seq??0});
          }
          throw new ApiError(404,'调试接口不存在。');
        }
        if(pathname==='/session'&&req.method==='DELETE'){
          service.store.db.prepare('DELETE FROM sessions WHERE token=?').run(token!);res.setHeader('Set-Cookie','sv_next_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return send(res,{ok:true});
        }
        if(pathname==='/bootstrap'&&req.method==='GET')return send(res,{person:actor,mode:'mock',recognition,tasks:service.list()});
        if(pathname==='/tasks'&&req.method==='GET')return send(res,service.taskPage(z.string().max(200).parse(url.searchParams.get('q')??''),z.coerce.number().int().min(1).max(100000).parse(url.searchParams.get('page')??1)));
        if(pathname==='/standards'&&req.method==='GET')return send(res,service.registry.catalog(z.string().max(160).parse(url.searchParams.get('material')??''),z.string().max(160).parse(url.searchParams.get('supplier')??''),z.coerce.number().int().min(1).max(100000).parse(url.searchParams.get('page')??1)));
        if(pathname==='/checks'&&req.method==='GET')return send(res,{items:service.standaloneRecent(actor)});
        if(pathname==='/checks'&&req.method==='POST'){
          const input=z.object({standardId:z.string().uuid(),version:z.number().int().positive(),clientId:z.string().min(1).max(100)}).strict().parse(await jsonBody(req));
          return send(res,service.startStandalone(input.standardId,input.version,input.clientId,actor),201);
        }
        if(pathname==='/reference/green-mat-v1.png'&&req.method==='GET')return await file(res,path.join(root,'fixtures/inspection/green-mat-v1/reference-crop.png'),true);
        const taskMatch=pathname.match(/^\/tasks\/([A-Z0-9]+)(?:\/(open|rounds))?$/);
        if(taskMatch){const [,id,action]=taskMatch;service.authorizeTask(id,actor);
          if(req.method==='GET'&&!action)return send(res,service.view(id));
          if(req.method==='POST'&&action==='open'){await jsonBody(req);return send(res,service.open(id));}
          if(req.method==='POST'&&action==='rounds'){const data=z.object({reuse:z.boolean()}).parse(await jsonBody(req));return send(res,service.newRound(id,data.reuse));}
        }
        const fileMatch=pathname.match(/^\/files\/([a-f0-9-]+\.(png|jpg|webp))$/);
        if(fileMatch&&req.method==='GET')return await file(res,path.join(state,'files',fileMatch[1]),true);
        const match=pathname.match(/^\/rounds\/([a-f0-9-]+)\/(sample|sample-set|real-trial|photos|remove|notes|review|analyze|complete|submit|report\.md)$/);
        if(match){const [,id,action]=match;service.authorizeTask(service.round(id).taskId,actor);
          if(action==='report.md'&&req.method==='GET'){
            const round=service.round(id);res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="${round.taskId}-R${round.number}.md"`,'Cache-Control':'private, no-store'});return res.end(service.report(round));
          }
          if(req.method!=='POST')throw new ApiError(405,'此操作不支持该请求方式。');
          if(action==='photos'){
            if(uploads>=2){req.resume();throw new ApiError(429,'当前有其他照片正在保存，请稍后重试。');}
            uploads++;
            try {
              const bytes=await body(req,22*1024*1024);
              const request=new Request('http://localhost/upload',{method:'POST',headers:{'Content-Type':req.headers['content-type']??''},body:new Uint8Array(bytes)});
              const data=await request.formData(),photo=data.get('photo');
              if(!(photo instanceof File))throw new ApiError(400,'请选择一张照片。');
              const revision=revisionSchema.parse(Number(data.get('revision')));
              return send(res,await service.addPhoto(id,revision,{bytes:Buffer.from(await photo.arrayBuffer()),filename:photo.name,width:Number(data.get('width')),height:Number(data.get('height')),replaceId:String(data.get('replaceId')??'')||undefined,clientId:z.string().min(1).max(100).parse(data.get('clientId'))},actor));
            } finally { uploads--; }
          }
          const data=await jsonBody(req),revision=revisionSchema.parse(data.revision);
          if(action==='real-trial')return send(res,await service.addRealTrial(id,revision,actor));
          if(action==='sample'){const input=z.object({sample:z.enum(['pass','fail','four','twenty','quality']),replaceId:z.string().optional()}).parse(data);return send(res,await service.addSample(id,revision,input.sample,input.replaceId,actor));}
          if(action==='sample-set'){const input=z.object({clientId:z.string().min(1).max(100)}).parse(data);return send(res,await service.addTwentyPhotos(id,revision,input.clientId,actor));}
          if(action==='remove')return send(res,service.remove(id,revision,z.string().parse(data.photoId),actor));
          if(action==='notes')return send(res,service.notes(id,revision,z.string().parse(data.instruction),actor));
          if(action==='review'){const input=z.object({componentId:z.string(),verdict:z.enum(['PASS','FAIL']),reason:z.string()}).parse(data);return send(res,service.review(id,revision,input.componentId,input.verdict,input.reason,actor));}
          if(action==='analyze'){if(debugRuns?.running)throw new ApiError(409,'本机模型正在执行调试，请稍后开始检测。');return send(res,service.analyze(id,revision),202);}
          if(action==='complete')return send(res,service.complete(id,revision,actor));
          if(action==='submit')return send(res,service.submit(id,revision,actor,data.simulateFailure===true),202);
        }
        throw new ApiError(404,'接口不存在。');
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new ApiError(405,'请求方式不支持。');
      if(!pathname.startsWith(MARKING_BASE+'/')&&pathname!==MARKING_BASE)throw new ApiError(404,'页面不存在。');
      const staticPath=pathname.slice(MARKING_BASE.length)||'/';
      const full=path.resolve(staticDir,'.'+staticPath);
      if(full!==staticDir&&!full.startsWith(staticDir+path.sep))throw new ApiError(404,'文件不存在。');
      try { if((await stat(full)).isFile())return await file(res,full); } catch { /* Client routes use the application entry. */ }
      if(path.extname(staticPath))throw new ApiError(404,'文件不存在。');
      return await file(res,path.join(staticDir,'index.html'));
    } catch(error){
      if(res.headersSent){res.destroy();return;}
      const status=error instanceof ApiError?error.status:error instanceof z.ZodError?400:500;
      if(status===500)console.error('请求处理失败',error);
      send(res,{message:error instanceof z.ZodError?'请求参数不完整或格式不正确。':status===500?'服务暂时无法完成操作，请稍后重试。':(error as Error).message},status);
    }
  });
  server.requestTimeout=120000;server.headersTimeout=15000;
  server.listen(options.port ?? Number(process.env.SV_PORT??5190),options.host??process.env.SV_HOST??'0.0.0.0',()=>{
    const addr=server.address();if(!addr||typeof addr==='string')return;
    console.log(`新版平板工作台（${vision?'VLM真实识别，MES模拟':'本地模拟'}）：http://127.0.0.1:${addr.port}${MARKING_BASE}`);
    for(const entries of Object.values(os.networkInterfaces()))for(const entry of entries??[])if(entry.family==='IPv4'&&!entry.internal&&/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))console.log(`局域网试用：http://${entry.address}:${addr.port}${MARKING_BASE}`);
  });
  return {server,service,admin};
}

export function runStandalone(){
  const {server,service,admin}=startServer();
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
    service.closing=true;admin.files.close();service.vision?.close?.();server.closeAllConnections();server.close();
    setTimeout(()=>{service.store.close();process.exit(0);},service.interval+100).unref();
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)runStandalone();

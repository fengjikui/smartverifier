import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { imageSchema, modelReplySchema } from './contracts.ts';
import { validateReplyItems, validateSeparation } from './validation.ts';
import { TraceStore } from './trace-store.ts';
import { replyJsonSchema } from './reply-json-schema.ts';
import type { AIJudgement, ComponentResult, Photo, Preparation, Round } from '../../shared/types.ts';

const preparedSchema=z.object({version:z.string(),width:z.number().int().positive(),height:z.number().int().positive(),originalWidth:z.number().int().positive(),originalHeight:z.number().int().positive(),originalToUpright:z.array(z.number()).length(9),upright:imageSchema,annotated:imageSchema,sheet:imageSchema,
  components:z.array(z.object({componentId:z.string().uuid(),quadPx:z.array(z.tuple([z.number(),z.number()])).length(4),modelView:imageSchema,viewToUprightOriginal:z.array(z.number()).length(9),rotationClockwiseDegrees:z.number(),
    quality:z.object({state:z.enum(['usable','needs_recapture']),reasons:z.array(z.string())}),routeHint:z.literal('unclassified'),bbox:z.tuple([z.number(),z.number(),z.number(),z.number()]),metrics:z.record(z.number()),label:z.string()})),
  issues:z.array(z.string()),coverage:z.enum(['complete','uncertain']),elapsedMs:z.number(),greenRatio:z.number(),opencv:z.string(),resourcesBefore:z.unknown().optional(),resourcesAfter:z.unknown().optional(),workerPeakRssMiB:z.number().optional()});

export interface VisionPipeline {
  model:string;
  prepare(photo:Photo):Promise<{preparation:Preparation;components:ComponentResult[]}>;
  recognize(round:Round,photo:Photo,component:ComponentResult):Promise<AIJudgement|null>;
  close?():void;
}
export class RecognitionProblem extends Error { kind:'quality'|'error'; constructor(kind:'quality'|'error',message:string){super(message);this.kind=kind;} }

/** 单个工作队列串行调用；所有图片均来自本系统文件区，不接收任意路径或远程图。 */
export class LocalVisionPipeline implements VisionPipeline {
  root:string;directory:string;python:string;model:string;endpoint:string;template:string;traceDirectory?:string;inputLayout:'legacy'|'prefix-first';structured:boolean;
  children=new Set<ChildProcess>();
  constructor(root:string,directory:string,options:{python?:string;model?:string;endpoint?:string;template?:string;traceDirectory?:string;inputLayout?:'legacy'|'prefix-first';structured?:boolean}={}){
    this.root=root;this.directory=directory;this.python=options.python??process.env.SV_VISION_PYTHON??path.join(root,'agent-tools/image-focus/.venv/bin/python');
    this.model=options.model??process.env.SV_LM_MODEL??'hr-qwen';this.endpoint=options.endpoint??process.env.SV_LM_ENDPOINT??'http://127.0.0.1:1234/v1';
    this.template=options.template??process.env.SV_LM_TEMPLATE??path.join(os.homedir(),'.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-4bit/chat_template.jinja');
    this.traceDirectory=options.traceDirectory;
    this.inputLayout=z.enum(['legacy','prefix-first']).parse(options.inputLayout??process.env.SV_VISION_INPUT_LAYOUT??'prefix-first');
    this.structured=options.structured??process.env.SV_VISION_SCHEMA!=='0';
    const url=new URL(this.endpoint);if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.username||url.password)throw new Error('本机识别只允许回环 LM Studio 地址。');
  }
  async worker(request:Record<string,unknown>,timeout:number):Promise<unknown>{
    return await new Promise((resolve,reject)=>{
      const child=spawn(this.python,[path.join(this.root,'next/server/vision/local_worker.py')],{stdio:['pipe','pipe','pipe'],env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}});
      this.children.add(child);child.once('close',()=>this.children.delete(child));
      let out='',err='',settled=false;
      const fail=(error:Error)=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);};
      const timer=setTimeout(()=>{child.kill('SIGTERM');fail(new RecognitionProblem('error','本机模型响应超时，已保留照片及完成结果，请稍后重试。'));},timeout);
      child.on('error',()=>fail(new RecognitionProblem('error','图像处理环境不可用，请先按部署说明安装 Python 依赖。')));
      child.stdout.on('data',b=>{out+=b.toString();if(out.length>5*1024*1024){child.kill();fail(new Error('模型响应超出长度限制。'));}});
      child.stderr.on('data',b=>{err=(err+b.toString()).slice(-4000);});
      child.stdin.on('error',()=>{});
      child.on('close',code=>{if(settled)return;clearTimeout(timer);try{const data=JSON.parse(out);if(code!==0||data.error){console.error('本机视觉处理失败',data.error??err);if(request.action==='separate'&&data.type==='ValueError')throw new RecognitionProblem('quality',data.error);throw new RecognitionProblem('error',String(data.error).startsWith('RESOURCE_PRESSURE:')?String(data.error).slice(18):data.type==='TimeoutError'?'模型本次未在55秒内完成，请重试或改用更小的模型。':'本机图像处理或模型调用失败，请检查 LM Studio 已加载模型与部署配置后重试。');}settled=true;resolve(data);}catch(e){fail(e instanceof RecognitionProblem?e:new RecognitionProblem('error','本机视觉服务未返回有效结果，请检查服务后重试。'));}});
      child.stdin.end(JSON.stringify(request));
    });
  }
  close(){for(const child of this.children)child.kill('SIGTERM');}
  filename(assetId:string){if(!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(assetId))throw new Error('图片引用无效');return path.join(this.directory,'files',assetId);}
  async prepare(photo:Photo){
    const raw=preparedSchema.parse(await this.worker({action:'separate',source:this.filename(photo.file),folder:path.join(this.directory,'files'),label:'P'+String(photo.sequence).padStart(3,'0')},15000));
    const source=await readFile(this.filename(photo.file));
    if(createHash('sha256').update(source).digest('hex')!==photo.hash)throw new Error('原图校验不一致，停止处理。');
    const original={...raw.upright,assetId:photo.file,sha256:photo.hash,bytes:source.length,width:raw.originalWidth,height:raw.originalHeight,mime:photo.file.endsWith('.jpg')?'image/jpeg' as const:photo.file.endsWith('.webp')?'image/webp' as const:'image/png' as const};
    validateSeparation({photoId:photo.id,photoVersion:1,original,upright:raw.upright,originalToUpright:raw.originalToUpright as [number,number,number,number,number,number,number,number,number]}, {
      protocol:'sv.vision.v1',photoId:photo.id,photoVersion:1,sourceSha256:photo.hash,separatorId:'opencv-green-mat',separatorVersion:raw.opencv,preprocessingVersion:raw.version,
      status:raw.coverage==='complete'?'completed':'recapture_required',coverage:raw.coverage,
      components:raw.components.map(({componentId,quadPx,modelView,viewToUprightOriginal,rotationClockwiseDegrees,quality,routeHint})=>({componentId,photoId:photo.id,photoVersion:1,sourceSha256:photo.hash,quadPx,modelView,viewToUprightOriginal,rotationClockwiseDegrees,quality,routeHint})),
      issues:raw.issues.map(message=>({code:'RECAPTURE',message,componentIds:[]})),
    });
    const artifact={...raw,sourceSha256:photo.hash,photoId:photo.id};await this.record('separation',artifact);
    return {preparation:{version:raw.version,sourceHash:photo.hash,uprightUrl:'/api/files/'+raw.upright.assetId,annotatedUrl:'/api/files/'+raw.annotated.assetId,sheetUrl:'/api/files/'+raw.sheet.assetId,width:raw.width,height:raw.height,elapsedMs:raw.elapsedMs,coverage:raw.coverage,issues:raw.issues},
      components:raw.components.map((c,index):ComponentResult=>({id:c.componentId,label:c.label,index,bbox:c.bbox,ai:null,aiHistory:[],review:null,reviewHistory:[],crop:{url:'/api/files/'+c.modelView.assetId,assetId:c.modelView.assetId,width:c.modelView.width,height:c.modelView.height,rotation:c.rotationClockwiseDegrees,qualityReasons:c.quality.reasons}}))};
  }
  reference(round:Round){
    if(round.standard.image==='/api/reference/green-mat-v1.png')return path.join(this.root,'fixtures/inspection/green-mat-v1/reference-crop.png');
    if(/^\/assets\/[a-zA-Z0-9_.-]+\.(png|jpg|webp)$/.test(round.standard.image))return path.join(this.root,'outputs/next-web/dist',round.standard.image);
    throw new RecognitionProblem('error','当前正品图片没有配置可读取的本地文件，请联系管理员。');
  }
  async record(kind:string,data:unknown){const dir=path.join(this.directory,'vision-records');await mkdir(dir,{recursive:true,mode:0o700});const name=randomUUID()+'.json';await writeFile(path.join(dir,name),JSON.stringify({kind,at:new Date().toISOString(),data},null,2),{mode:0o600});return name;}
  async recognize(round:Round,photo:Photo,c:ComponentResult):Promise<AIJudgement|null>{
    if(!c.crop)throw new Error('缺少元件裁片');
    const traceId=randomUUID(),traces=this.traceDirectory?new TraceStore(this.traceDirectory):null;
    let raw;
    try{raw=await this.worker({action:'recognize',componentId:c.id,reference:this.reference(round),sample:this.filename(c.crop.assetId),description:round.standard.description,instruction:round.instruction,endpoint:this.endpoint,model:this.model,template:this.template,
      inputLayout:this.inputLayout,...(this.structured?{responseSchema:replyJsonSchema([c.id])}:{}),
      ...(traces?{traceDirectory:this.traceDirectory,traceId,traceMetadata:{taskId:round.taskId,roundId:round.id,photoId:photo.id,label:round.taskId+' · '+c.label,sourceHash:photo.hash,standardVersion:round.standard.version,instructionVersion:round.instructionVersion}}:{})},65000) as {response:{choices:{finish_reason:string;message:{content:string}}[]};elapsedMs:number;model:string;promptVersion:string};}
    catch(error){if(traces)await traces.failure(traceId,(error as Error).message,{source:'inspection',model:this.model,componentIds:[c.id],taskId:round.taskId});throw error;}
    const record=await this.record('recognition',{taskId:round.taskId,roundId:round.id,photoId:photo.id,sourceHash:photo.hash,componentId:c.id,standardId:round.standard.id,standardVersion:round.standard.version,standardDescription:round.standard.description,instructionVersion:round.instructionVersion,onsiteInstruction:round.instruction,...raw});
    const choice=raw.response?.choices?.[0];
    let reply;
    try{if(choice?.finish_reason!=='stop')throw new Error('生成没有完整结束');reply=parsePairReply(choice.message.content,c.id);if(traces)await traces.finish(traceId,true,'完整JSON与元件编号校验通过。');}
    catch{if(traces)await traces.finish(traceId,false,'生成未完整结束，或JSON字段、元件编号校验未通过。');throw new RecognitionProblem('error','模型返回格式或元件编号不完整，本件未生成结论，请重试。');}
    if(reply.items.length!==1||reply.items[0].componentId!==c.id)throw new RecognitionProblem('error','模型返回的元件编号不匹配，已拒绝写入，请重试。');
    const item=reply.items[0];if(item.status==='unreadable')throw new RecognitionProblem('quality','图片质量过低，请重新拍照。'+item.reason);
    if(item.confidence===null||!item.lines.length)throw new RecognitionProblem('error','模型缺少丝印内容或判断把握，本件未生成明确结论，请重试。');
    return {verdict:item.verdict,lines:item.lines,confidence:item.confidence,reason:item.reason,instructionVersion:round.instructionVersion,source:'lmstudio',model:raw.model,elapsedMs:raw.elapsedMs,promptVersion:raw.promptVersion,rawRecord:record,features:item.features,differences:item.differences,instructionConflicts:reply.instructionConflicts,instructionWarnings:instructionPriorityWarnings(round.instruction,reply)};
  }
}

export function parsePairReply(content:string,componentId:string){
  return parseBatchReply(content,[componentId]);
}

export function parseBatchReply(content:string,componentIds:string[]){
  // 接受整个响应恰好被一层代码围栏包裹，不搜索/拼补损坏的 JSON。
  const text=content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1');
  return validateReplyItems(componentIds,JSON.parse(text));
}

export function instructionPriorityWarnings(instruction:string,reply:z.infer<typeof modelReplySchema>){
  // 模型有时按现场说明放行差异，却漏填conflicts。此处是系统提示，不改写模型原文。
  return instruction.trim()&&reply.items.some(i=>i.status==='decided'&&i.verdict==='PASS'&&i.differences.length)&&!reply.instructionConflicts.length
    ?['系统提示（非模型原文）：存在可见差异但结论为合格，且本次设置了优先现场说明。请核对现场说明与正品标准的关系；本次已按现场说明执行。']:[];
}

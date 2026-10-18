import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseBatchReply } from './local-pipeline.ts';
import type { LocalVisionPipeline } from './local-pipeline.ts';
import { replyJsonSchema } from './reply-json-schema.ts';
import { TraceStore } from './trace-store.ts';

export class DebugRuns{
  pipeline:LocalVisionPipeline;store:TraceStore;running=false;
  constructor(pipeline:LocalVisionPipeline,store:TraceStore){this.pipeline=pipeline;this.store=store;}
  start(mode:'single'|'board4'|'board6',format:'prompt-json'|'json-schema',actor:string,inputLayout:'legacy'|'prefix-first'='prefix-first'){
    if(this.running)throw new Error('已有调试请求正在执行');
    const id=randomUUID(),ids=mode==='single'?['C01']:mode==='board4'?['C02','C03','C04','C06']:['C01','C02','C03','C04','C05','C06'];
    const reference=path.join(this.pipeline.root,'fixtures/inspection/green-mat-v1/reference-crop.png');
    const sample=mode==='single'?reference:path.join(this.pipeline.root,'next/research/whiteboard-batching/examples',mode==='board4'?'sheet-4.png':'sheet-6.png');
    this.running=true;
    void(async()=>{
      try{
        const raw=await this.pipeline.worker({action:'recognize',componentId:ids[0],componentIds:ids,reference,sample,description:'',instruction:'',model:this.pipeline.model,endpoint:this.pipeline.endpoint,template:this.pipeline.template,
          provider:this.pipeline.provider,extraBody:this.pipeline.extraBody,timeoutSeconds:this.pipeline.timeoutSeconds,maxTokens:220+280*ids.length,traceDirectory:this.store.directory,traceId:id,requireIdle:true,inputLayout,
          traceMetadata:{source:'debug-sample',label:`${ids.length}件白板调试（模拟图）`,actor},...(format==='json-schema'?{responseSchema:replyJsonSchema(ids)}:{})},this.pipeline.timeoutSeconds*1000+10000) as {response:{choices:{finish_reason:string;message:{content:string}}[]}};
        const choice=raw.response?.choices?.[0];if(choice?.finish_reason!=='stop')throw new Error('生成未完整结束');
        try{parseBatchReply(choice.message.content,ids);await this.store.finish(id,true,'完整JSON、字段与元件ID集合校验通过；这是调试记录，不提交MES。');}
        catch(error){await this.store.finish(id,false,(error as Error).message);}
      }catch(error){await this.store.failure(id,(error as Error).message,{model:this.pipeline.model,source:'debug-sample',label:`${ids.length}件调试失败`,componentIds:ids});}
      finally{this.running=false;}
    })().catch(error=>console.error('调试记录写入失败',error));
    return id;
  }
}

/** 导入既有EXP-007真实证据；旧日志没有时序，不生成虚假的逐件时间。 */
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseBatchReply } from '../server/vision/local-pipeline.ts';
import type { TraceEvent, TraceImage, TraceMessage } from '../shared/model-trace.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const source=path.resolve(process.argv[2]??path.join(root,'outputs/whiteboard-batching-20261018/run-01'));
const destination=path.join(path.resolve(process.argv[3]??path.join(root,'outputs/next-state')),'vision-traces');
const manifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
const config=JSON.parse(await readFile(path.join(source,'run-config.json'),'utf8'));
const evaluated=JSON.parse(await readFile(path.join(source,'evaluated.json'),'utf8'));
const imagesByHash=new Map([manifest.reference,...manifest.components.map((c:{image:unknown})=>c.image),...Object.values(manifest.sheets),...Object.values(manifest.permutedSheets??{})].map(image=>[image.sha256,image]));
let imported=0;
for(const record of evaluated.records){
  if(record.mode==='warmup')continue;
  const key=createHash('sha256').update('EXP-007/'+record.sequence+'/'+record.promptSha256).digest('hex').slice(0,32);
  const id=[key.slice(0,8),key.slice(8,12),key.slice(12,16),key.slice(16,20),key.slice(20)].join('-'),folder=path.join(destination,id);
  try{await access(path.join(folder,'events.ndjson'));continue;}catch{/* 新记录 */}
  const prompt=config.promptBase+'\n本次必须返回的componentId列表：'+JSON.stringify(record.componentIds).replaceAll(',',', ');
  if(createHash('sha256').update(prompt).digest('hex')!==record.promptSha256)throw new Error('历史提示词哈希不匹配，拒绝猜测导入');
  await mkdir(folder,{recursive:true,mode:0o700});
  const images:TraceImage[]=[],blocks:TraceMessage['content']=[{type:'text',text:prompt}];
  for(const input of record.inputMetrics){
    const asset=imagesByHash.get(input.sha256);if(!asset)throw new Error('历史图片不在清单中');
    const bytes=await readFile(path.join(source,asset.file));if(createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw new Error('历史图片哈希不匹配');
    await writeFile(path.join(folder,`image-${images.length}.png`),bytes,{mode:0o600});
    blocks.push({type:'image',imageIndex:images.length});images.push({index:images.length,width:asset.width,height:asset.height,bytes:bytes.length,sha256:asset.sha256});
  }
  const choice=record.response?.choices?.[0],now=Date.now()/1000;
  let valid=false,message='旧调用未完整结束';
  if(choice?.finish_reason==='stop')try{parseBatchReply(choice.message.content,record.componentIds);valid=true;message='历史完整JSON、字段与ID集合校验通过；未记录逐token或逐件时间。';}catch(e){message=(e as Error).message;}
  const events:TraceEvent[]=[
    {seq:1,type:'request',at:now,elapsedMs:0,source:'benchmark',historical:true,model:config.model,label:`EXP-007 R${record.repeat} · ${record.mode}`,componentIds:record.componentIds,messages:[{role:'user',content:blocks}],images},
    {seq:2,type:'prediction_started',at:now,elapsedMs:0,responseFormat:'prompt-json',enableThinking:false,maxTokens:220+280*record.componentIds.length,temperature:0},
    {seq:3,type:'generation_finished',at:now,elapsedMs:record.callWallMs,output:choice?.message.content??'',finishReason:choice?.finish_reason??'error',stats:record.response?.lmstudio?.stats,reasoningTokens:record.response?.usage?.reasoning_tokens??0},
    {seq:4,type:'validation',at:now,elapsedMs:record.callWallMs,valid,message},
  ];
  await writeFile(path.join(folder,'events.ndjson'),events.map(e=>JSON.stringify(e)).join('\n')+'\n',{mode:0o600});imported++;
}
console.log(`已导入${imported}条历史调用。旧记录只有总耗时和SDK统计，逐件时序不补造。`);

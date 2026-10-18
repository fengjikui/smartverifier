import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBatchReply } from '../../server/vision/local-pipeline.ts';
import { modelReplySchema } from '../../server/vision/contracts.ts';
import type { ModelReply } from '../../server/vision/contracts.ts';
import { alignText } from '../../shared/domain.ts';

type Truth={componentId:string;source:string;expectedLines:string[];expectedVerdict:'PASS'|'FAIL';referenceDependent:boolean;image:{file:string;sha256:string;width:number;height:number}};
type Call={sequence:number;repeat:number;mode:string;componentIds:string[];callWallMs:number;modelWallMs?:number;inputMetrics?:{sentWidth:number;sentHeight:number;encodedBytes:number}[];response?:{choices:{finish_reason:string;message:{content:string}}[];usage?:unknown;lmstudio?:{stats:unknown;template_source_sha256:string}};error?:unknown;[key:string]:unknown};

/** 格式失败仍做按唯一ID的离线诊断，但绝不把部分/坏合同标成可提交结果。 */
export function scoreCall(call:Call,truths:Truth[]){
  const choice=call.response?.choices?.[0];let reply:ModelReply|null=null,issue='';
  try{if(choice?.finish_reason!=='stop')throw new Error('没有完整结束');reply=parseBatchReply(choice.message.content,call.componentIds);}catch(e){issue=(e as Error).message;}
  let raw:unknown;
  try{raw=JSON.parse((choice?.message.content??'').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1'));}catch{/* 不拼补损坏JSON。 */}
  const rawItems:unknown[]=raw&&typeof raw==='object'&&'items' in raw&&Array.isArray(raw.items)?raw.items:[];
  const itemId=(item:unknown)=>item!==null&&typeof item==='object'&&'componentId' in item?item.componentId:undefined;
  const actualIds=rawItems.map(itemId),duplicates=[...new Set(actualIds.filter((id,i)=>actualIds.indexOf(id)!==i))];
  const unknown=actualIds.filter(id=>!call.componentIds.includes(String(id)));
  const rows=call.componentIds.map(id=>{
    const truth=truths.find(c=>c.componentId===id);if(!truth)throw new Error('评分清单缺少元件 '+id);
    let item=reply?.items.find(i=>i.componentId===id);
    if(!item&&actualIds.filter(x=>x===id).length===1){const parsed=modelReplySchema.safeParse({items:rawItems.filter(i=>itemId(i)===id),instructionConflicts:[]});if(parsed.success)item=parsed.data.items[0];}
    const actual=item?.lines??[];const lineCount=Math.max(truth.expectedLines.length,actual.length);
    const characterErrors=Array.from({length:lineCount},(_,i)=>alignText(truth.expectedLines[i]??'',actual[i]??'').filter(c=>c.different).length).reduce((a,b)=>a+b,0);
    return {componentId:id,expectedLines:truth.expectedLines,expectedVerdict:truth.expectedVerdict,observed:item??null,
      textExact:!!item&&JSON.stringify(actual)===JSON.stringify(truth.expectedLines),verdictCorrect:item?.status==='decided'&&item.verdict===truth.expectedVerdict,
      falsePass:truth.expectedVerdict==='FAIL'&&item?.verdict==='PASS',falseFail:truth.expectedVerdict==='PASS'&&item?.verdict==='FAIL',
      unreadable:item?.status==='unreadable',missing:!actualIds.includes(id),duplicate:duplicates.includes(id),invalid:!item,
      characterErrors,characterCount:truth.expectedLines.join('').length};
  });
  return {...call,protocolValid:!!reply,protocolIssue:issue,duplicateIds:duplicates,unknownIds:unknown,rows,
    counts:{expected:rows.length,textExact:rows.filter(r=>r.textExact).length,verdictCorrect:rows.filter(r=>r.verdictCorrect).length,
      falsePass:rows.filter(r=>r.falsePass).length,falseFail:rows.filter(r=>r.falseFail).length,unreadable:rows.filter(r=>r.unreadable).length,
      missing:rows.filter(r=>r.missing).length,invalid:rows.filter(r=>r.invalid).length,characterErrors:rows.reduce((s,r)=>s+r.characterErrors,0),characterCount:rows.reduce((s,r)=>s+r.characterCount,0)}};
}

const median=(xs:number[])=>{const sorted=[...xs].sort((a,b)=>a-b);return sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;};
export function compareCalls(records:ReturnType<typeof scoreCall>[],groups:Record<string,string[]>){
  const comparisons=[];
  for(const [group,ids] of Object.entries(groups)){
    const mode=group==='four'?'board4':'board6';
    const batches=records.filter(r=>r.mode===mode&&r.repeat>0);
    const perRound=batches.map(batch=>{
      const single=records.filter(r=>r.mode==='single'&&r.repeat===batch.repeat&&ids.includes(r.componentIds[0]));
      if(single.length!==ids.length||new Set(single.map(r=>r.componentIds[0])).size!==ids.length)throw new Error('对照轮缺少对应的逐件调用');
      const pixels=(calls:Call[])=>calls.every(c=>c.inputMetrics?.length)?calls.flatMap(c=>c.inputMetrics!).reduce((s,m)=>s+m.sentWidth*m.sentHeight,0):null;
      return {repeat:batch.repeat,singleWallMs:single.reduce((s,r)=>s+r.callWallMs,0),batchWallMs:batch.callWallMs,singleSentPixels:pixels(single),batchSentPixels:pixels([batch]),
        singleProtocolValid:single.filter(r=>r.protocolValid).length,batchProtocolValid:batch.protocolValid,
        singleCounts:single.reduce((sum,r)=>Object.fromEntries(Object.entries(r.counts).map(([k,v])=>[k,(sum[k]??0)+v])),{} as Record<string,number>),batchCounts:batch.counts};
    });
    if(!perRound.length)continue;
    const singleMedian=median(perRound.map(r=>r.singleWallMs)),batchMedian=median(perRound.map(r=>r.batchWallMs));
    comparisons.push({group,componentIds:ids,perRound,singleMedianMs:singleMedian,batchMedianMs:batchMedian,speedup:singleMedian/batchMedian,timeReductionPercent:100*(1-batchMedian/singleMedian),
      observations:ids.length*perRound.length,
      singleTextExact:perRound.reduce((s,r)=>s+r.singleCounts.textExact,0),batchTextExact:perRound.reduce((s,r)=>s+r.batchCounts.textExact,0),
      singleVerdictCorrect:perRound.reduce((s,r)=>s+r.singleCounts.verdictCorrect,0),batchVerdictCorrect:perRound.reduce((s,r)=>s+r.batchCounts.verdictCorrect,0),
      batchProtocolValid:perRound.filter(r=>r.batchProtocolValid).length,rounds:perRound.length,
      batchFalsePass:perRound.reduce((s,r)=>s+r.batchCounts.falsePass,0),batchFalseFail:perRound.reduce((s,r)=>s+r.batchCounts.falseFail,0),batchMissing:perRound.reduce((s,r)=>s+r.batchCounts.missing,0)});
  }
  return comparisons;
}

async function main(){
  const folder=path.resolve(process.argv[2]??'outputs/whiteboard-batching-20261018/run-01');
  const manifest=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
  const config=JSON.parse(await readFile(path.join(folder,'run-config.json'),'utf8'));
  const files=(await readdir(path.join(folder,'raw'))).filter(s=>s.endsWith('.json')).sort();
  const records=[];for(const name of files)records.push(scoreCall(JSON.parse(await readFile(path.join(folder,'raw',name),'utf8')),manifest.components));
  const comparisons=compareCalls(records,manifest.groups);
  let compositionTimings;try{compositionTimings=JSON.parse(await readFile(path.join(folder,'composition-timings.json'),'utf8'));}catch{/* 可在合成探针完成后补充，不伪造时间。 */}
  const result={experiment:'EXP-007',date:'2026-10-18',syntheticOnly:true,uniqueComponents:manifest.components.length,
    config,manifest,records,comparisons,compositionTimings,limitations:['只有6个生成元件，其中C01与参考图来自同一张照片','两次重复和换排布不是新增独立样本','模型内部有效图像尺寸未知，不拿SDK的prompt_tokens当完整视觉token','耗时不含轮间休息或共用定位；本次只试验，尚未接入日常业务队列']};
  await writeFile(path.join(folder,'evaluated.json'),JSON.stringify(result,null,2)+'\n');
  if(process.argv.includes('--publish')){
    const destination=fileURLToPath(new URL('./',import.meta.url));
    const compact={...result,records:records.map(r=>({...r,response:r.response?{choices:r.response.choices,usage:r.response.usage,lmstudio:{stats:r.response.lmstudio?.stats,template_source_sha256:r.response.lmstudio?.template_source_sha256}}:undefined}))};
    await writeFile(path.join(destination,'results.json'),JSON.stringify(compact,null,2)+'\n');
    await mkdir(path.join(destination,'examples'),{recursive:true});
    for(const name of ['sheet-4.png','sheet-6.png','sheet-4-permuted.png','sheet-6-permuted.png'])await copyFile(path.join(folder,name),path.join(destination,'examples',name));
  }
  console.log(JSON.stringify(comparisons,null,2));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))await main();

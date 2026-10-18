import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCall } from '../whiteboard-batching/summarize.ts';
type Cache={status:string;cachedTokens:number;uncachedTokens:number;expandedInputTokens:number;hitFraction:number;records:string[]};
type Response={choices:{finish_reason:string;message:{content:string}}[];usage:unknown;lmstudio:{stats:{timeToFirstTokenSec:number;predictedTokensCount:number;tokensPerSecond:number};template_source_sha256:string;enable_thinking:boolean}};
type Scored=ReturnType<typeof scoreCall>&{cache:Cache;warmup:boolean;modelWallMs:number;response:Response;promptLimitIssues:string[]};
const folder=path.resolve(process.argv[2]??'outputs/prefix-cache-20261018/run-02');
const manifest=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
const config=JSON.parse(await readFile(path.join(folder,'run-config.json'),'utf8'));
const records:Scored[]=[];for(const name of (await readdir(path.join(folder,'raw'))).filter(s=>s.endsWith('.json')).sort()){
  const raw=JSON.parse(await readFile(path.join(folder,'raw',name),'utf8'));
  if(raw.error||!raw.response?.lmstudio?.stats)throw new Error('存在失败或缺少统计的调用，不能生成完整成功对照');
  const score=scoreCall(raw,manifest.components);
  records.push({...score,cache:raw.cache as Cache,warmup:raw.warmup===true,modelWallMs:raw.modelWallMs as number,response:raw.response as Response,promptLimitIssues:score.rows.filter(r=>r.observed&&r.observed.features.length>1).map(r=>r.componentId)});
}
if(records.length!==config.schedule.length)throw new Error('实验尚未完成，不生成完整对照结论');
const median=(xs:number[])=>{const sorted=[...xs].sort((a,b)=>a-b);return sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;};
const summaries=manifest.arms.filter((arm:{name:string})=>records.some(r=>r.mode===arm.name&&!r.warmup)).map((arm:{name:string;layout:string;schema:boolean})=>{
  const calls=records.filter(r=>r.mode===arm.name&&!r.warmup);
  const cache=calls.map(r=>r.cache).filter(c=>c.status==='observed');
  const stats=calls.map(r=>r.response?.lmstudio?.stats);
  const cached=cache.reduce((s,c)=>s+c.cachedTokens,0),total=cache.reduce((s,c)=>s+c.expandedInputTokens,0);
  return {arm:arm.name,inputLayout:arm.layout,schema:arm.schema,changingPhotoCalls:calls.length,
    medianWallMs:median(calls.map(r=>r.callWallMs)),medianModelMs:median(calls.map(r=>r.modelWallMs)),medianFirstTokenMs:median(stats.map(s=>s.timeToFirstTokenSec*1000)),
    medianOutputTokens:median(stats.map(s=>s.predictedTokensCount)),medianTokensPerSecond:median(stats.map(s=>s.tokensPerSecond)),
    cacheObservedCalls:cache.length,medianCachedTokens:median(cache.map(c=>c.cachedTokens)),aggregateCacheHitFraction:total?cached/total:null,
    expected:calls.reduce((s,r)=>s+r.counts.expected,0),textExact:calls.reduce((s,r)=>s+r.counts.textExact,0),verdictCorrect:calls.reduce((s,r)=>s+r.counts.verdictCorrect,0),
    falsePass:calls.reduce((s,r)=>s+r.counts.falsePass,0),falseFail:calls.reduce((s,r)=>s+r.counts.falseFail,0),missing:calls.reduce((s,r)=>s+r.counts.missing,0),
    protocolValid:calls.filter(r=>r.protocolValid).length,promptLimitIssues:calls.reduce((s,r)=>s+r.promptLimitIssues.length,0),
    perPhoto:calls.map(r=>({number:r.repeat,wallMs:r.callWallMs,ttftMs:r.response?.lmstudio?.stats.timeToFirstTokenSec*1000,outputTokens:r.response?.lmstudio?.stats.predictedTokensCount,cache:r.cache,counts:r.counts}))};
});
const compact={experiment:'EXP-008',phase:manifest.phase??'counterbalanced-comparison',date:'2026-10-18',syntheticOnly:true,uniqueGeneratedCrops:4,manifest,config,summaries,
  records:records.map(r=>({...r,response:r.response?{choices:r.response.choices,usage:r.response.usage,lmstudio:{stats:r.response.lmstudio.stats,template_source_sha256:r.response.lmstudio.template_source_sha256,enable_thinking:r.response.lmstudio.enable_thinking}}:undefined})),
  limitations:[...manifest.limitations,manifest.phase==='sequential-cache-probe'?'连续探针不参与正式换图中位数，不把原样重复当作新样本':'预热每条件1次不计入；换图每条件4次，不能形成生产准确率或统计显著性结论','新顺序增加system角色与固定协议确认语以绕开运行时重排，不只是交换一个JSON数组','缓存指标为单请求时间区间内唯一Prompt cache restore日志；没有可靠独立视觉编码时长']};
await writeFile(path.join(folder,'evaluated.json'),JSON.stringify(compact,null,2)+'\n');
if(process.argv.includes('--publish')){
  const destination=fileURLToPath(new URL('./',import.meta.url));await writeFile(path.join(destination,manifest.phase==='sequential-cache-probe'?'cache-probe-results.json':'results.json'),JSON.stringify(compact,null,2)+'\n');
  await mkdir(path.join(destination,'examples'),{recursive:true});for(const i of manifest.phase==='sequential-cache-probe'?[5]:[1,2,3,4])await copyFile(path.join(folder,`photo-${i}.png`),path.join(destination,'examples',`photo-${i}.png`));
}
console.log(JSON.stringify(summaries,null,2));

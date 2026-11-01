/** 人工启动的有限真实推理。先独立加载候选实例；本脚本不切换默认模型、不改业务数据。 */
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { LocalVisionPipeline } from '../../server/vision/local-pipeline.ts';
import { pythonExecutable,pythonEnvironment } from '../../server/python-runtime.ts';
import { apiPath } from '../../shared/paths.ts';
import type { Photo,Round } from '../../shared/types.ts';

const root=fileURLToPath(new URL('../../',import.meta.url));
function argument(key:string,fallback?:string){const i=process.argv.indexOf(key);const value=i<0?fallback:process.argv[i+1];if(!value)throw new Error('Missing '+key);return value;}
const baseline=argument('--baseline','hr-qwen'),candidate=argument('--candidate');
const baselineTemplate=argument('--baseline-template'),candidateTemplate=argument('--candidate-template');
const out=path.resolve(argument('--output'));await mkdir(path.join(out,'state/files'),{recursive:true});
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const resources=()=>JSON.parse(execFileSync(pythonExecutable(root),['-c','from server.vision.local_worker import check_resources; import json; print(json.dumps(check_resources()))'],{cwd:root,encoding:'utf8',env:pythonEnvironment(),timeout:10000}));
const initialModels=await (await fetch('http://127.0.0.1:1234/api/v1/models')).json() as {models:{key:string;loaded_instances:{id:string;config:unknown}[]}[]};
for(const id of [baseline,candidate])if(!initialModels.models.some(m=>m.loaded_instances.some(i=>i.id===id)))throw new Error('Model instance not loaded: '+id);
const evidence={at:new Date().toISOString(),synthetic:true,repeats:1,scope:'Current whole-photo protocol smoke; not production accuracy or stable speedup',
  environment:{platform:process.platform,arch:process.arch,node:process.version,totalMemoryBytes:os.totalmem(),loaded:initialModels.models.flatMap(m=>m.loaded_instances.map(i=>({key:m.key,...i})))},
  codeHashes:Object.fromEntries(await Promise.all(['server/vision/local_worker.py','server/vision/local-pipeline.ts','server/vision/photo-reply.ts','server/vision/vlm_client/silkscreen_prompts.py'].map(async f=>[f,sha(await readFile(path.join(root,f)))]))),
  resources:[] as unknown[],runs:[] as Record<string,unknown>[]};
const cases=[
  {id:'single',file:'fixtures/inspection/green-mat-v1/single.png',reference:'green',failures:[]},
  {id:'pair',file:'fixtures/inspection/green-mat-v1/pair.png',reference:'green',failures:[1]},
  {id:'four',file:'fixtures/inspection/four-components.png',reference:'gray',failures:[2]},
];
const counts:Record<string,number>={single:1,pair:2,four:4};
async function save(){await writeFile(path.join(out,'results.json'),JSON.stringify(evidence,null,2)+'\n');}
try{
 for(const [model,template] of [[baseline,baselineTemplate],[candidate,candidateTemplate]]){
  const pipeline=new LocalVisionPipeline(root,path.join(out,'state'),{model,template,provider:'lmstudio',endpoint:'http://127.0.0.1:1234/v1',timeoutSeconds:90,inputLayout:'prefix-first',structured:true,traceDirectory:path.join(out,'traces')});
  try{for(const c of cases){
   const resource=resources();evidence.resources.push({model,case:c.id,...resource});
   const bytes=await readFile(path.join(root,c.file)),file=randomUUID()+'.png';await writeFile(path.join(out,'state/files',file),bytes);
   const photo:Photo={id:randomUUID(),sequence:1,filename:path.basename(c.file),file,url:apiPath('/files/'+file),hash:sha(bytes),width:1536,height:1024,sample:null,status:'pending',message:'',components:[]};
   const round:Round={id:randomUUID(),taskId:'RESEARCH20261101',number:1,revision:1,status:'draft',createdAt:new Date().toISOString(),instruction:'',instructionVersion:1,nextPhotoSequence:2,photos:[photo],transfer:null,
    standard:{id:'SYNTHETIC-REFERENCE',version:1,material:'SYN-SV358',supplier:'generated-fixture',image:apiPath('/reference/green-mat-v1.png'),lines:['SV358','A26','0147'],description:'核对各行丝印字符、顺序、标志及封装特征。允许拍照背景、光照与角度变化，不允许型号或固定丝印变化。'}};
   // 四件照片使用同批灰底参考图，复用当前支持的本地参考资产协议。
   if(c.reference==='gray'){
    const refFile=randomUUID()+'.png';await writeFile(path.join(out,'state/files',refFile),await readFile(path.join(root,'fixtures/inspection/reference.png')));
    round.standard.image=apiPath('/reference-assets/'+refFile);
   }
   const row:Record<string,unknown>={model,case:c.id,input:c.file,inputSha256:photo.hash,expectedCount:counts[c.id],expectedVerdicts:Array.from({length:counts[c.id]},(_,i)=>c.failures.includes(i)?'FAIL':'PASS')};
   const started=performance.now();
   try{
    photo.preparation=(await pipeline.prepare(photo)).preparation;
    const result=await pipeline.recognizePhoto(round,photo);row.clientElapsedMs=Math.round(performance.now()-started);row.schemaValid=true;row.qualityReasons=result.qualityReasons;
    row.components=result.components.map(item=>({index:item.index,bbox:item.bbox,lines:item.ai?.lines,verdict:item.ai?.verdict,confidence:item.ai?.confidence,reason:item.reason}));
    row.countExact=result.components.length===counts[c.id];
    row.verdictsExact=row.countExact&&result.components.every((item,i)=>item.ai?.verdict===(c.failures.includes(i)?'FAIL':'PASS'));
    row.linesExact=row.countExact&&result.components.every((item,i)=>JSON.stringify(item.ai?.lines)===JSON.stringify([c.failures.includes(i)?'SV385':'SV358','A26','0147']));
    const record=result.components.find(item=>item.ai?.rawRecord)?.ai?.rawRecord;
    if(record){const raw=JSON.parse(await readFile(path.join(out,'state/vision-records',record),'utf8')).data;row.modelElapsedMs=raw.elapsedMs;row.usage=raw.response?.usage;row.inputMetrics=raw.inputMetrics;row.promptVersion=raw.promptVersion;}
   }catch(error){row.clientElapsedMs=Math.round(performance.now()-started);row.schemaValid=false;row.error=(error as Error).message;}
   evidence.runs.push(row);await save();console.log(JSON.stringify(row));
  }}finally{pipeline.close();}
 }
}finally{evidence.resources.push({stage:'after',...resources()});await save();}

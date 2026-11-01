/** 隔离的 180 秒 VLM 对照，不修改生产配置/检测结论。 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pythonExecutable,pythonEnvironment} from '../../server/python-runtime.ts';
import {LocalVisionPipeline} from '../../server/vision/local-pipeline.ts';
import {apiPath} from '../../shared/paths.ts';
import type {Photo,Round} from '../../shared/types.ts';
const knownRoi=process.argv.includes('--known-bad-roi');
const variant=knownRoi?'oracle-roi':process.argv.includes('--image-only')?'image-only':'confirmed';
const root=process.cwd(),folder=path.join(root,'outputs/ocr-localization-20261101/vlm-'+variant);
await mkdir(path.join(folder,'files'),{recursive:true});
const pipeline=new LocalVisionPipeline(root,folder,{model:'hr-qwen',provider:'lmstudio',endpoint:'http://127.0.0.1:1234/v1',timeoutSeconds:180,inputLayout:'prefix-first',structured:true,traceDirectory:path.join(folder,'traces')});
const manifest=JSON.parse(await readFile('fixtures/inspection/ocr-exploration-v1/manifest.json','utf8'));
const output=[];
const cases:any[]=[];
if(knownRoi){const source=manifest.scenes.find((s:any)=>s.id==='eighteen-two-differences');for(const id of ['C08','C17']){const roi=source.parts.find((p:any)=>p.id===id).roi,file=path.join(folder,id+'.png');execFileSync(pythonExecutable(root),['-c','from PIL import Image;import sys,json;Image.open(sys.argv[1]).crop(json.loads(sys.argv[3])).save(sys.argv[2])',source.file,file,JSON.stringify(roi)],{env:pythonEnvironment()});cases.push({...source,id:source.id+'-'+id,file,oracleSource:source.file,oracleSourceSha256:source.sha256,oracleRoi:roi});}}
else for(const id of (process.argv.includes('--confusable-only')?['confusable-pair']:['eighteen-two-differences','confusable-pair']))cases.push(manifest.scenes.find((s:any)=>s.id===id));
try{for(const scene of cases){
 const sid=scene.id,sample=await readFile(scene.file),reference=await readFile(scene.reference_file),photoFile=randomUUID()+'.png',referenceFile=randomUUID()+'.png';
 await writeFile(path.join(folder,'files',photoFile),sample);await writeFile(path.join(folder,'files',referenceFile),reference);
 const photo:Photo={id:randomUUID(),sequence:1,filename:scene.file,file:photoFile,url:apiPath('/files/'+photoFile),hash:createHash('sha256').update(sample).digest('hex'),width:1536,height:1024,sample:null,status:'pending',message:'',components:[]};
 const round:Round={id:randomUUID(),taskId:'RESEARCH20261101',number:1,revision:1,status:'draft',createdAt:new Date().toISOString(),instruction:'',instructionVersion:1,nextPhotoSequence:2,photos:[photo],transfer:null,standard:{id:'RESEARCH',version:1,material:sid,supplier:'合成研究样片',image:apiPath('/reference-assets/'+referenceFile),lines:scene.reference_lines,description:'严格逐字符比对固定丝印；允许光照与拍摄角度不同。形近字按正品录入文字和图片共同核对，但不能把样品的实际差异自动改写为标准文字。不能辨明时说明不确定。'}};
 if(variant==='image-only')round.standard.lines=[];
 const r:any={id:sid,variant,model:'hr-qwen',timeoutSeconds:180,inputSha256:photo.hash,referenceSha256:createHash('sha256').update(reference).digest('hex'),...(knownRoi?{oracleSource:scene.oracleSource,oracleSourceSha256:scene.oracleSourceSha256,oracleRoi:scene.oracleRoi}:{})},at=performance.now();
 try{photo.preparation=(await pipeline.prepare(photo)).preparation;const recognized=await pipeline.recognizePhoto(round,photo);r.result=recognized;const rawRecord=recognized.components.find(c=>c.ai?.rawRecord)?.ai?.rawRecord;if(rawRecord)r.raw=JSON.parse(await readFile(path.join(folder,'vision-records',rawRecord),'utf8')).data;}
 catch(e){r.error=(e as Error).message;}
 r.elapsedMs=Math.round(performance.now()-at);output.push(r);await writeFile(path.join(folder,'result.json'),JSON.stringify(output,null,2));console.log(JSON.stringify({id:sid,elapsedMs:r.elapsedMs,error:r.error,count:r.result?.components?.length}));
}}finally{pipeline.close();}

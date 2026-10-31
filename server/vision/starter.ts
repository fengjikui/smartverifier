/** 独立模拟接入，不实例化业务服务、不读环境密钥、不调用模型或MES。 */
import { readFile,mkdir,mkdtemp,writeFile,copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { photoInputSchema,basisSchema,VisionContractError } from './contracts.ts';
import type { ComponentSeparator,PhotoInput,SeparationResult,ImageAsset,AdapterContext } from './contracts.ts';
import { validateSeparation,validateReplyItems } from './validation.ts';
import { ocrResultSchema,validateOcrResult } from './ocr-contracts.ts';
import type { OcrAdapter,OcrRequest,OcrResult } from './ocr-contracts.ts';

export const starterOptionsSchema=z.object({separate:z.boolean().default(false),backend:z.enum(['vlm','lightweight','auto']).default('vlm'),reference:z.enum(['clear','ambiguous','low-confidence','unknown']).default('clear')}).strict();
export type StarterOptions=z.infer<typeof starterOptionsSchema>;
export const referenceSignalsSchema=z.object({quality:z.enum(['clear','poor','uncertain']),confidence:z.number().min(0).max(1).optional(),ambiguities:z.array(z.object({text:z.string(),reason:z.string()}))});
type Signals=z.infer<typeof referenceSignalsSchema>;
export function selectStarterRoute(options:StarterOptions,signals?:Signals){
 if(options.backend==='lightweight'&&!options.separate)throw new VisionContractError('OCR_REQUIRES_CROP','轻量OCR示例仅支持单件裁片，请开启前置分割，或选择整图VLM。不会自动替你打开分割。');
 const reasons:string[]=[];let selected:'vlm'|'lightweight';
 if(options.backend!=='auto'){selected=options.backend;reasons.push('手动选择，未按自评分自动改写后端。');}
 else if(!options.separate){selected='vlm';reasons.push('未启用分割，轻量示例不支持整图多件，选择整图VLM。');}
 else if(!signals||signals.confidence===undefined){selected='vlm';reasons.push('正品分析信息不足，保守选择VLM。');}
 else if(signals.quality!=='clear'||signals.ambiguities.length||signals.confidence<.9){selected='vlm';reasons.push('正品分析存在质量提示、字形歧义或把握不足，建议VLM。');}
 else{selected='lightweight';reasons.push('正品清晰、无字形歧义且自评分至少0.9，试验性推荐轻量OCR。');}
 return {selected,reasons,version:'starter-route-v1',experimental:true as const,signals:signals??null};
}
const files={'original':'../../fixtures/inspection/green-mat-v1/pair.png','reference':'../../fixtures/inspection/green-mat-v1/reference-crop.png','crop-1':'crop-1.png','crop-2':'crop-2.png'} as const;
export type StarterAssetId=keyof typeof files;
const folder=(root:string)=>path.join(root,'examples/vision-starter');
const json=async(root:string,name:string)=>JSON.parse(await readFile(path.join(folder(root),name),'utf8'));
export function starterAsset(root:string,id:string){if(!Object.hasOwn(files,id))throw new Error('未知样例图片');return path.resolve(folder(root),files[id as StarterAssetId]);}
async function checkAsset(root:string,id:StarterAssetId,asset:ImageAsset){
 const data=await readFile(starterAsset(root,id));
 if(data.length!==asset.bytes||createHash('sha256').update(data).digest('hex')!==asset.sha256||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||data.readUInt32BE(16)!==asset.width||data.readUInt32BE(20)!==asset.height)throw new Error('样例资产哈希或尺寸不一致：'+id);
}
export class MockSeparator implements ComponentSeparator{
 root:string;constructor(root:string){this.root=root;}
 async separate(input:PhotoInput,context:AdapterContext):Promise<SeparationResult>{context.signal.throwIfAborted();return validateSeparation(input,await json(this.root,'separation.mock.json'));}
}
export class MockOcr implements OcrAdapter{
 root:string;constructor(root:string){this.root=root;}
 async recognize(input:OcrRequest,context:AdapterContext){
  context.signal.throwIfAborted();const rows=z.array(ocrResultSchema).parse(await json(this.root,'ocr.mock.json'));
  const matches=rows.filter(r=>r.componentId===input.componentId);if(matches.length!==1)throw new Error('模拟OCR元件不存在或重复');
  return validateOcrResult(input,{...matches[0],requestId:input.requestId});
 }
}
export function requireOcrEvidence(result:OcrResult){
 if(result.state!=='completed'||!result.lines.some(l=>l.text.trim()))throw new VisionContractError('OCR_EVIDENCE_UNAVAILABLE','OCR未得到可用读文，请改选VLM继续验证；这不是图片模糊或不合格结论。');
 return result.lines.map(l=>l.text);
}
export async function runStarter(root:string,raw:unknown){
 const at=performance.now(),options=starterOptionsSchema.parse(raw),input=photoInputSchema.parse(await json(root,'input.json'));
 await checkAsset(root,'original',input.original);
 const basis=basisSchema.parse(await json(root,'basis.json'));await checkAsset(root,'reference',basis.referenceImage);
 const signals=options.reference==='unknown'?undefined:referenceSignalsSchema.parse(await json(root,'reference-analysis.mock.json'));
 if(signals&&options.reference==='ambiguous')signals.ambiguities=[{text:'S/5',reason:'人为设置的路由测试歧义，不是本图实际识别结论'}];
 if(signals&&options.reference==='low-confidence')signals.confidence=.65;
 const route=selectStarterRoute(options,signals),context={signal:new AbortController().signal};
 const separation=options.separate?await new MockSeparator(root).separate(input,context):null;
 if(separation)for(const c of separation.components){const id=c.componentId==='starter-c1'?'crop-1':c.componentId==='starter-c2'?'crop-2':null;if(!id)throw new Error('未知模拟元件');await checkAsset(root,id,c.modelView);}
 const requests:OcrRequest[]=[],ocr:OcrResult[]=[];
 if(route.selected==='lightweight')for(const c of separation!.components){const request={requestId:crypto.randomUUID(),componentId:c.componentId,photoId:input.photoId,photoVersion:input.photoVersion,sourceSha256:input.original.sha256,image:c.modelView};requests.push(request);const value=await new MockOcr(root).recognize(request,context);requireOcrEvidence(value);ocr.push(value);}
 // VLM端同样是人工真值替身，不向真实VLM发送请求。固定双件图用于证明串号与错字处理。
 const ids=separation?.components.map(c=>c.componentId)??['starter-c1','starter-c2'];
 const reply=validateReplyItems(ids,{items:ids.map(componentId=>({componentId,status:'decided',verdict:componentId==='starter-c1'?'PASS':'FAIL',lines:route.selected==='lightweight'?ocr.find(r=>r.componentId===componentId)!.lines.map(l=>l.text):[componentId==='starter-c1'?'SV358':'SV385','A26','0147'],confidence:null,reason:'模拟固定真值，未运行识别模型；不能用于业务判定。',features:[],differences:componentId==='starter-c1'?[]:[{category:'text',message:'模拟型号末两位顺序不同',lineIndex:0,referenceText:'SV358',sampleText:'SV385'}]})),instructionConflicts:[]});
 return {mode:'mock' as const,notice:'固定人工选框与预设读文；没有CV定位、真实OCR或VLM调用，不写入检测任务或MES。',options,route,input,basis,separation,ocrRequests:requests,ocr,reply,stages:[{name:'读取样图与校验',state:'completed'},{name:'前置定位分割',state:options.separate?'mock':'skipped'},{name:route.selected==='vlm'?'VLM识别':'轻量OCR识别',state:'mock'}],elapsedMs:Math.round((performance.now()-at)*100)/100};
}
export type StarterRun=Awaited<ReturnType<typeof runStarter>>;
export async function exportStarter(root:string,raw:unknown,base=path.join(root,'var/vision-starter')){
 const run=await runStarter(root,raw);await mkdir(base,{recursive:true});const output=await mkdtemp(path.join(base,'run-'));
 await writeFile(path.join(output,'run.json'),JSON.stringify(run,null,2)+'\n');
 await writeFile(path.join(output,'input.json'),JSON.stringify(run.input,null,2)+'\n');
 await writeFile(path.join(output,'basis.json'),JSON.stringify(run.basis,null,2)+'\n');
 const assets:Record<string,string>={[run.input.original.assetId]:'original.png',[run.basis.referenceImage.assetId]:'reference.png'};
 for(const c of run.separation?.components??[])assets[c.modelView.assetId]=c.componentId==='starter-c1'?'crop-1.png':'crop-2.png';
 await writeFile(path.join(output,'assets.json'),JSON.stringify(assets,null,2)+'\n');
 if(run.separation)await writeFile(path.join(output,'separation.output.json'),JSON.stringify(run.separation,null,2)+'\n');
 for(const [i,request] of run.ocrRequests.entries()){await writeFile(path.join(output,`ocr-${i+1}.input.json`),JSON.stringify(request,null,2)+'\n');await writeFile(path.join(output,`ocr-${i+1}.output.json`),JSON.stringify(run.ocr[i],null,2)+'\n');}
 for(const id of Object.keys(files))if(id==='original'||id==='reference'||run.options.separate)await copyFile(starterAsset(root,id),path.join(output,id+'.png'));
 return {output,run};
}

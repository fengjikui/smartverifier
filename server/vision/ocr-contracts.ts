import { z } from 'zod';
import { imageSchema } from './contracts.ts';
import type { AdapterContext } from './contracts.ts';

const id=z.string().min(1).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/),point=z.tuple([z.number().finite().nonnegative(),z.number().finite().nonnegative()]);
const source={requestId:id,componentId:id,photoId:id,photoVersion:z.number().int().positive(),sourceSha256:hash};
export const ocrRequestSchema=z.object({...source,image:imageSchema}).strict();
export const ocrResultSchema=z.object({...source,inputSha256:hash,state:z.enum(['completed','failed']),lines:z.array(z.object({text:z.string().max(512),quadPx:z.tuple([point,point,point,point]),score:z.number().finite().nullable()}).strict()).max(100),engine:id,modelVersion:id,preprocessingVersion:id,scoreMeaning:z.string().max(1000),elapsedMs:z.number().finite().nonnegative(),warnings:z.array(z.string().max(1000)).max(30),error:z.object({code:id,message:z.string().max(2000)}).strict().nullable()}).strict();
export type OcrRequest=z.infer<typeof ocrRequestSchema>;
export type OcrResult=z.infer<typeof ocrResultSchema>;
export interface OcrAdapter { recognize(input:OcrRequest,context:AdapterContext):Promise<OcrResult> }
export function validateOcrResult(rawInput:OcrRequest,raw:unknown):OcrResult{
 const input=ocrRequestSchema.parse(rawInput),result=ocrResultSchema.parse(raw);
 for(const key of ['requestId','componentId','photoId','photoVersion','sourceSha256'] as const)if(input[key]!==result[key])throw new Error('OCR返回了旧输入或错误元件：'+key);
 if(input.image.sha256!==result.inputSha256)throw new Error('OCR输入裁片哈希不匹配');
 if((result.state==='failed')!==(result.error!==null)||result.state==='failed'&&result.lines.length)throw new Error('OCR失败状态与错误信息不一致');
 for(const line of result.lines){
  if(line.quadPx.some(([x,y])=>x>input.image.width||y>input.image.height))throw new Error('OCR文字框超出输入裁片');
  const cross=line.quadPx.map((p,i,a)=>{const q=a[(i+1)%4],r=a[(i+2)%4];return (q[0]-p[0])*(r[1]-q[1])-(q[1]-p[1])*(r[0]-q[0]);});
  if(!cross.every(v=>v>0)&&!cross.every(v=>v<0))throw new Error('OCR文字框须为沿边界排列的非退化凸四边形');
 }
 return result;
}

import { z } from 'zod';
import { modelReplySchema } from './contracts.ts';
import { replyJsonSchema } from './reply-json-schema.ts';

const bbox = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().positive().max(1), z.number().positive().max(1)])
  .refine(([x,y,w,h])=>x+w<=1.001&&y+h<=1.001,'元件位置超出原图');
const options = modelReplySchema.shape.items.element.options;
export const photoReplySchema = modelReplySchema.extend({
  quality: z.object({state:z.enum(['usable','needs_recapture']),reason:z.string().max(2000)}).strict(),
  coverage:z.enum(['complete','uncertain']),
  items:z.array(z.discriminatedUnion('status',[options[0].extend({bbox}),options[1].extend({bbox})])).max(100),
});
export type PhotoReply=z.infer<typeof photoReplySchema>;
export const photoComponentId=(index:number)=>'C'+String(index+1).padStart(2,'0');
export function photoJsonSchema(){
  const schema=replyJsonSchema(Array.from({length:100},(_,i)=>photoComponentId(i)));
  return {...schema,required:[...schema.required,'quality','coverage'],properties:{...schema.properties,
    quality:{type:'object',additionalProperties:false,required:['state','reason'],properties:{state:{type:'string',enum:['usable','needs_recapture']},reason:{type:'string'}}},
    coverage:{type:'string',enum:['complete','uncertain']},items:{...schema.properties.items,minItems:0,maxItems:100,items:{...schema.properties.items.items,
      required:[...schema.properties.items.items.required,'bbox'],properties:{...schema.properties.items.items.properties,bbox:{type:'array',minItems:4,maxItems:4,items:{type:'number',minimum:0,maximum:1}}}}}}};
}
export function parsePhotoReply(content:string):PhotoReply{
  const text=content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1'),reply=photoReplySchema.parse(JSON.parse(text));
  const byId=new Map(reply.items.map(item=>[item.componentId,item]));
  if(byId.size!==reply.items.length)throw new Error('模型返回重复元件编号');
  if(!reply.items.length&&(reply.quality.state==='usable'&&reply.coverage==='complete'))throw new Error('模型没有返回元件，不能作为有效完成结果');
  const items=reply.items.map((_,index)=>{const item=byId.get(photoComponentId(index));if(!item)throw new Error('模型元件编号不连续，无法可靠对应结果');return item;});
  for(const item of items)if(item.status==='decided'&&(item.confidence===null||!item.lines.length))throw new Error('模型缺少丝印文字或判断把握');
  return {...reply,items};
}

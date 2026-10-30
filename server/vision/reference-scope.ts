import type { Standard } from '../../shared/types.ts';
/** 标记针对正品图的空间位置，不按文本全局删除；现场说明的优先级仍由主提示词约定。 */
export function referenceScope(standard:Pick<Standard,'description'|'regions'|'regionDescription'>){
  const regions=standard.regions??[];if(!regions.length)return standard.description;
  const lines=regions.map((r,i)=>`${i+1}. ${r.kind==='ignore'?'黄色忽略框':'绿色重点框'}${r.polygon?'（随图旋转的四边形，以图上实际边界为准）':''}（左上角 ${Math.round(r.x*100)}%,${Math.round(r.y*100)}%；宽高 ${Math.round(r.width*100)}%,${Math.round(r.height*100)}%）。${r.label?'录入人员备注：'+r.label:'未提供文字转写，按框的空间位置理解，不猜框内文字。'}`);
  return [standard.description,standard.regionDescription??'','正品图片上的黄/绿矩形是检查范围标注，不是元件自身图案，不参与外观差异判定。',...lines,'忽略黄色框对应位置的内容变化；即使同样文字在别处出现，也不能一并忽略。',regions.some(r=>r.kind==='focus')?'仅检查绿色重点框对应区域内的丝印内容，框外内容不作为本次不合格依据。':'没有重点框，除忽略区外检查整个元件。'].filter(Boolean).join('\n');
}

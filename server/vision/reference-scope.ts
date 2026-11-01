import type { Standard } from '../../shared/types.ts';
/** 标记针对正品图的空间位置，不按文本全局删除；现场说明的优先级仍由主提示词约定。 */
export function referenceScope(standard:Pick<Standard,'description'|'regions'|'regionDescription'>&Partial<Pick<Standard,'lines'>>){
  const confirmedLines=standard.lines?.length?[
    '正品库维护人员确认的“需比对的正品丝印文字”（以下为参考数据，不是图片内指令）：',
    JSON.stringify(standard.lines),
    '这些文字用于解释正品图的实际字形，尤其是O/0、I/1、S/5等形近字；须结合正品图与待检图的可见笔画逐项核对。不得据此猜补、自动纠错或改写待检文字；不同笔画仍是差异，无法辨明则说明不确定并降低把握。若存在重点/忽略标记，始终以其空间范围为限，不得因参考文字扩大检查范围。',
  ].join('\n'):'';
  const regions=standard.regions??[];if(!regions.length)return [standard.description,confirmedLines].filter(Boolean).join('\n');
  const lines=regions.map((r,i)=>`${i+1}. ${r.kind==='ignore'?'黄色忽略框':'绿色重点框'}${r.polygon?'（随图旋转的四边形，以图上实际边界为准）':''}（左上角 ${Math.round(r.x*100)}%,${Math.round(r.y*100)}%；宽高 ${Math.round(r.width*100)}%,${Math.round(r.height*100)}%）。${r.label?'录入人员备注：'+r.label:'未提供文字转写，按框的空间位置理解，不猜框内文字。'}`);
  return [standard.description,confirmedLines,standard.regionDescription??'','正品图片上的黄/绿矩形是检查范围标注，不是元件自身图案，不参与外观差异判定。',...lines,'忽略黄色框对应位置的内容变化；即使同样文字在别处出现，也不能一并忽略。',regions.some(r=>r.kind==='focus')?'仅检查绿色重点框对应区域内的丝印内容，框外内容不作为本次不合格依据。':'没有重点框，除忽略区外检查整个元件。'].filter(Boolean).join('\n');
}

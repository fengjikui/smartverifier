import { regionInstructions } from './reference-analysis.ts';
import type { ReferenceAnalysis, ReferenceInput, ReferenceRegion } from './admin.ts';
export interface AnalysisText { lines:string[];description:string;plainDescription?:string }
export function analysisText(a:ReferenceAnalysis,regions:ReferenceRegion[]):AnalysisText {return {lines:a.result?.lines??[],description:[a.result?.description,regionInstructions(regions,a)].filter(Boolean).join('\n'),plainDescription:a.result?.description};}
/** 只更新空字段或上次自动填写的字段，异步结果不能覆盖用户正在编辑的内容。 */
export function analysisAutofill(input:Pick<ReferenceInput,'lines'|'description'>,next:AnalysisText,previous?:AnalysisText):Partial<ReferenceInput>{
 return {...(!input.lines.join('\n').trim()||previous&&JSON.stringify(input.lines)===JSON.stringify(previous.lines)?{lines:next.lines}:{}),...(!input.description.trim()||previous&&(input.description===previous.description||input.description===previous.plainDescription)?{description:next.description}:{})};
}

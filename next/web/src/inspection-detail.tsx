import { useLayoutEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { finalVerdict, isVlmJudgement } from '../../shared/domain';
import type { ComponentResult, Photo, Round } from '../../shared/types';
import { ComponentNavigator } from './component-navigator';
import { Btn, DiffTable, PhotoCrop, Pill, VerdictPill } from './ui';

export function InspectionDetail({round,photo,component,onSelect,onOriginal}: {
  round:Round;photo:Photo;component:ComponentResult;
  onSelect:(photo:Photo,component:ComponentResult)=>void;onOriginal:()=>void;
}) {
  const main=useRef<HTMLElement>(null);
  useLayoutEffect(()=>{main.current?.scrollTo({top:0,behavior:'instant'});},[component.id]);
  const entries=round.photos.flatMap(p=>p.components.map(c=>({photo:p,component:c})));
  const index=entries.findIndex(entry=>entry.component.id===component.id);
  const previous=entries.slice(0,index).findLast(entry=>entry.component.ai);
  const next=entries.slice(index+1).find(entry=>entry.component.ai);
  const ai=component.ai!;
  function choose(c:ComponentResult){const entry=entries.find(entry=>entry.component.id===c.id);if(entry)onSelect(entry.photo,c);}
  return <main className="sv-main sv-detail sv-inspection-detail" ref={main}>
    <div className="sv-detail-heading">
      <div className="sv-detail-title">
        <div><h1>元件 {String(index+1).padStart(2,'0')}</h1><VerdictPill verdict={finalVerdict(component)}/>{component.review?<Pill>人工已修正</Pill>:ai.confidence<.8?<Pill tone="warning">建议按需复核</Pill>:null}</div>
        <p>照片 P{String(photo.sequence).padStart(3,'0')} · 本轮第 {index+1} / {entries.length} 件</p>
        <div className="sv-detail-step"><Btn tone="quiet" className="sv-icon-button" aria-label="上一件元件" disabled={!previous} onClick={()=>{if(previous)onSelect(previous.photo,previous.component);}}><ChevronLeft size={18}/></Btn><Btn tone="quiet" className="sv-icon-button" aria-label="下一件元件" disabled={!next} onClick={()=>{if(next)onSelect(next.photo,next.component);}}><ChevronRight size={18}/></Btn></div>
      </div>
      <ComponentNavigator scope="task" components={entries.map(entry=>entry.component)} selected={component.id} onSelect={choose}/>
    </div>
    {(ai.instructionConflicts?.length||ai.instructionWarnings?.length)?<div className="sv-photo-attention"><span>本次按现场检验人员指示进行检测：{[...(ai.instructionConflicts??[]),...(ai.instructionWarnings??[])].join('；')}</span></div>:null}<div className="sv-compare"><section className="sv-panel"><h2>待检元件</h2><div className="sv-photo-stage"><PhotoCrop photo={photo} component={component}/></div></section><section className="sv-panel"><h2>正品基准</h2><div className="sv-photo-stage"><img className="sv-reference" src={round.standard.image} alt="本轮采用的正品基准"/></div></section></div>
    <DiffTable expected={round.standard.lines} actual={ai.lines} reason={component.review?'AI原判与识别文字保留，最终结论以人工核对结果为准。':ai.reason}/>
    <div className="sv-detail-secondary">
      <details key={component.id}><summary>检测依据与修正记录</summary><p>AI判断把握 {Math.round(ai.confidence*100)}%{isVlmJudgement(ai)?'（模型自评）':'（样例预设）'} · AI原判{ai.verdict==='PASS'?'合格':'不合格'}</p>{isVlmJudgement(ai)?<p>{ai.model} · {((ai.elapsedMs??0)/1000).toFixed(1)}秒 · {ai.promptVersion}</p>:null}{ai.features?.length?<p>外观特征：{ai.features.join('；')}</p>:null}<p>正品标准 v{round.standard.version} · 检测说明 v{round.instructionVersion} · 元件来源 {component.label}</p>{component.review?<p>人工修正：{component.review.person.name} · {new Date(component.review.at).toLocaleString('zh-CN')} · {component.review.reason}</p>:null}</details>
      <Btn tone="quiet" onClick={onOriginal}>查看原始照片</Btn>
    </div>
  </main>;
}

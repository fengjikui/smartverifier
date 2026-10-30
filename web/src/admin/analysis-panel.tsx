import { useEffect, useRef, useState } from 'react';
import { analysisIssues, regionInstructions } from '../../../shared/reference-analysis';
import { request } from '../api';
import { Btn, Spinner } from '../ui';
import type { ReferenceAnalysis, ReferenceRegion } from '../../../shared/admin';

export function AnalysisPanel({assetId,regions=[],onAnalysis,onComplete,onSuggestion}:{assetId:string;regions?:ReferenceRegion[];onAnalysis:(a:ReferenceAnalysis)=>void;onComplete:(a:ReferenceAnalysis)=>void;onSuggestion?:(a:ReferenceAnalysis)=>void}){
 const [analysis,setAnalysis]=useState<ReferenceAnalysis|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);const callbacks=useRef({onAnalysis,onComplete});callbacks.current={onAnalysis,onComplete};const signature=JSON.stringify(regions);
 useEffect(()=>{let active=true,timer:ReturnType<typeof setTimeout>;setAnalysis(null);setError('');async function follow(a:ReferenceAnalysis){if(!active)return;setAnalysis(a);callbacks.current.onAnalysis(a);if(a.state==='completed'){callbacks.current.onComplete(a);return;}if(a.state==='failed')return;timer=setTimeout(()=>void request<ReferenceAnalysis>('/admin/analyses/'+a.id).then(follow).catch(e=>{if(active)setError((e as Error).message);}),1000);}
 void request<ReferenceAnalysis>('/admin/analyses',{assetId,regions:JSON.parse(signature),fresh:attempt>0}).then(follow).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;clearTimeout(timer);};},[assetId,signature,attempt]);
 const running=!error&&(!analysis||analysis.state==='queued'||analysis.state==='running'),issues=analysisIssues(analysis??undefined),instructions=regionInstructions(regions,analysis??undefined),problem=!!error||analysis?.state==='failed'||analysis?.state==='completed'&&!!issues.length;
 return <details className={'adm-analysis-panel adm-analysis-compact'+(problem?' has-issues':'')} aria-label="正品图片自动分析" open={problem||undefined}>
  <summary>{running?<Spinner/>:null}<span>{error?'图片分析未完成':analysis?.state==='failed'?'分析失败，请重试':analysis?.state==='completed'?issues.length?'图片分析完成 · '+issues.length+'项待确认':analysis.inheritedFrom?'裁剪已应用 · 沿用原分析':'图片分析完成':'正在分析照片…'}</span><small>{running?'查看进展':'查看详情'}</small></summary>
  <div className="adm-analysis-body"><p role="status">{error||analysis?.message||'图片已保存，正在建立分析任务…'}</p>{running?<p className="adm-footnote">可先保存草稿，分析会在后台继续。</p>:null}
  {analysis?.state==='completed'?<>{issues.length?<ul className="adm-analysis-issues">{issues.map((s,i)=><li key={i}>{s}</li>)}</ul>:null}{analysis.inheritedFrom?<p className="adm-footnote">仅裁剪 / 旋转，沿用变换前的质量和文字分析。原始分析与变换记录保留；如需核对当前图片，可手动重新分析。</p>:<p className="adm-footnote">{analysis.model} · {((analysis.elapsedMs??0)/1000).toFixed(1)} 秒；判断把握 {Math.round((analysis.result?.confidence??0)*100)}%（模型自评）</p>}{onSuggestion&&analysis.result?.component?<Btn type="button" tone="quiet" onClick={()=>onSuggestion(analysis)}>采用建议裁剪 / 转正</Btn>:null}{instructions?<p className="adm-pre adm-footnote">{instructions}</p>:null}<p className="adm-footnote">判断依据：{analysis.result?.qualityReason}。自评不是经过标定的准确率。</p></>:null}
  {analysis?.state==='failed'||analysis?.state==='completed'||error?<Btn type="button" onClick={()=>setAttempt(n=>n+1)}>重新分析</Btn>:null}</div>
 </details>;
}

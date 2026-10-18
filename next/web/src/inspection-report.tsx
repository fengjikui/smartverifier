import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download } from 'lucide-react';
import { finalVerdict } from '../../shared/domain';
import { sampleMarker } from '../../shared/sample-presets';
import type { ComponentResult, Person, Photo, Round, Summary, Task } from '../../shared/types';
import { ComponentNavigator } from './component-navigator';
import { Btn, DiffTable, PhotoPill, Pill, VerdictPill } from './ui';

const photoName=(p:Photo)=>'P'+String(p.sequence).padStart(3,'0');

export function InspectionReport({round,summary,task,person,onOriginal}: {
  round:Round;summary:Summary|null|undefined;task:Task;person:Person;onOriginal:(photo:Photo)=>void;
}) {
  const [selected,setSelected]=useState<string|null>(null);
  const [articleNavigation,setArticleNavigation]=useState(false);
  const main=useRef<HTMLElement>(null),navigation=useRef<HTMLDivElement>(null);
  const sections=useRef(new Map<string,HTMLElement>()),pendingJump=useRef<string|null>(null);
  const entries=round.photos.flatMap(photo=>photo.components.map(component=>({photo,component})));
  const instructionNotices=[...new Set(entries.flatMap(({component:c})=>[...(c.ai?.instructionConflicts??[]),...(c.ai?.instructionWarnings??[])]))];
  const active=entries.find(entry=>entry.component.id===selected&&entry.component.ai)??entries.find(entry=>entry.component.ai);

  function moveTo(element:HTMLElement|null|undefined) {
    if(!element||!main.current)return;
    const headerHeight=navigation.current?.getBoundingClientRect().height??0;
    const inset=Number.parseFloat(getComputedStyle(main.current).paddingTop)||0;
    const top=main.current.scrollTop+element.getBoundingClientRect().top-main.current.getBoundingClientRect().top-headerHeight-inset-16;
    main.current.scrollTo({top:Math.max(0,top),behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    element.focus({preventScroll:true});
  }
  function choose(component:ComponentResult) {
    setSelected(component.id);
    pendingJump.current=component.id;
    setArticleNavigation(false);
  }
  useLayoutEffect(()=>{
    if(pendingJump.current){moveTo(sections.current.get(pendingJump.current));pendingJump.current=null;}
  },[articleNavigation]);

  return <main className="sv-main sv-report sv-inspection-report" ref={main}>
    <div className="sv-heading"><h1>丝印检测报告</h1><p>{task.number} · 第{round.number}轮</p></div>
    <section className="sv-panel sv-report-summary"><VerdictPill verdict={summary?.verdict??null}/><div><h2>已检测{summary?.completed??0}件 · 合格{summary?.pass??0}件 · 不合格{summary?.fail??0}件</h2></div><a className="sv-download" href={'/api/rounds/'+round.id+'/report.md'}><Download size={18}/>下载报告</a></section>
    {round.instruction||instructionNotices.length?<section className={instructionNotices.length?'sv-instruction-priority':'sv-panel sv-instruction-report'} role={instructionNotices.length?'status':undefined}><h2>{instructionNotices.length?'本次按现场检验人员指示检测':'现场检测说明（本次优先）'}</h2>{round.instruction?<p>{round.instruction}</p>:null}{instructionNotices.map((notice,i)=><p key={i}>{notice}</p>)}<small>现场说明优先于标准，随报告留档；内置预设样例仅演示流程。</small></section>:null}
    <div className="sv-report-navigation" ref={navigation}>
      <div className="sv-report-view-bar"><span>按拍摄顺序排列</span>{entries.length>1?<Btn tone="quiet" className="sv-report-locate" aria-expanded={articleNavigation} aria-controls="sv-report-components" onClick={()=>setArticleNavigation(!articleNavigation)}>{articleNavigation?'收起导航':'定位元件'}{articleNavigation?<ChevronUp size={16}/>:<ChevronDown size={16}/>}</Btn>:null}</div>
      {entries.length>1?<div id="sv-report-components" className="sv-report-seat-scroll" hidden={!articleNavigation}><ComponentNavigator scope="task" components={entries.map(entry=>entry.component)} selected={active?.component.id??''} onSelect={choose}/></div>:null}
    </div>
    {round.photos.map(photo=><section key={photo.id} className="sv-report-photo">
      <div className="sv-report-photo-heading"><h2>照片 {photoName(photo)} · {photo.components.length}个元件</h2><PhotoPill photo={photo}/></div>
      <ReportOriginal photo={photo} onOpen={()=>onOriginal(photo)}/>
      {photo.components.filter(component=>component.ai).map(component=><section key={component.id} tabIndex={-1} data-report-component={component.id} ref={node=>{if(node)sections.current.set(component.id,node);else sections.current.delete(component.id);}} className={'sv-report-component sv-report-entry'+(component.id===active?.component.id?' is-selected':'')} aria-label={component.label+'的检查结果'}>
        <div className="sv-report-component-heading"><h3>{component.label}</h3><VerdictPill verdict={finalVerdict(component)}/>{component.review?<Pill>人工已修正</Pill>:component.ai!.confidence<.8?<Pill tone="warning">建议按需复核</Pill>:null}</div>
        <ReportEvidence component={component} expected={round.standard.lines}/>
      </section>)}{photo.message?<p className="sv-description">{photo.message}</p>:null}
    </section>)}
    <details className="sv-report-trace"><summary>检测依据与追溯信息</summary><p>{round.standard.description}</p><p>正品标准 v{round.standard.version} · 检测说明 v{round.instructionVersion} · {person.name} {person.id}</p><p className="sv-description">带模型名称的结果为本机真实识别，其他为内置预设样例；原图、AI原判、人工修正人员和原因均保留。照片详情、完整报告和Markdown附件使用同一份检测结果。</p></details>
  </main>;
}

function ReportEvidence({component,expected}:{component:ComponentResult;expected:string[]}) {
  return <><DiffTable expected={expected} actual={component.ai!.lines} title="丝印文字对照" reason={component.review?'AI原识别差异保留；最终以人工核对结果为准。':component.ai!.reason}/><p className="sv-description">AI判断把握 {Math.round(component.ai!.confidence*100)}%{component.ai!.source==='lmstudio'?'（模型自评，非校准概率）':'（样例预设）'}</p>{component.ai!.source==='lmstudio'?<details className="sv-report-model-detail"><summary>模型与外观特征</summary><p>{component.ai!.model} · {((component.ai!.elapsedMs??0)/1000).toFixed(1)}秒</p><p>{component.ai!.features?.join('；')}</p></details>:null}{component.review?<p className="sv-review-record">{component.review.person.name} · {component.review.reason} · AI原判{component.ai!.verdict==='PASS'?'合格':'不合格'}保留</p>:null}</>;
}

function ReportOriginal({photo,onOpen}:{photo:Photo;onOpen:()=>void}) {
  return <div className="sv-report-original"><button className="sv-report-original-button" onClick={onOpen} aria-label={'查看照片 '+photoName(photo)+' 原图'}><img src={photo.preparation?.annotatedUrl??photo.url} alt={(photo.preparation?'元件定位与编号 ':'原始照片 ')+photoName(photo)} loading="lazy"/></button>
    {photo.sample==='four'?<div className="sv-sample-annotations">{[0,1,2,3].map(i=><img key={i} src={'/assets/report-frame'+(i?i:'')+'.svg'} width="626" height="310" alt=""/>)}{photo.components.map(c=><span key={c.id} className={'sv-sample-label label-'+c.index}>{String(c.index+1).padStart(2,'0')}</span>)}</div>:photo.sample==='twenty'?<svg className="sv-many-annotations" viewBox={`0 0 ${photo.width} ${photo.height}`} aria-label="20个元件的编号标记">{photo.components.map(c=>{const marker=sampleMarker(photo,c.index);return <g key={c.id} className={!c.ai?'is-pending':finalVerdict(c)==='FAIL'?'is-fail':'is-pass'}><rect x={marker.x} y={marker.y} width="152" height="100" rx="12"/><text x={marker.x+76} y={marker.y+74} textAnchor="middle">{String(c.index+1).padStart(2,'0')}</text></g>;})}</svg>:null}
  </div>;
}

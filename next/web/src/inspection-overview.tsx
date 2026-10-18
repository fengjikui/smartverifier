import type { RefObject } from 'react';
import { Camera, Grid3X3, ImagePlus, Plus } from 'lucide-react';
import { finalVerdict } from '../../shared/domain';
import type { Photo, TaskView } from '../../shared/types';
import { ActionMenu } from './action-menu';
import { Btn, PhotoPill, Pill } from './ui';

export type AlbumFilter='all'|'fail'|'attention';
export type OverviewActions={open:(photo:Photo)=>void;add:(kind:'camera'|'album')=>void;replace:(photo:Photo)=>void;remove:(photo:Photo)=>void;notes:()=>void;report:()=>void;samples:()=>void};
const photoName=(p:Photo)=>'P'+String(p.sequence).padStart(3,'0');
export function InspectionOverview({data,working,busy,compact,filter,onFilter,onToggleDensity,gallery,onScroll,actions,realEnabled,onRealTrial}: {
  data:TaskView;working:boolean;busy:boolean;compact:boolean;filter:AlbumFilter;onFilter:(filter:AlbumFilter)=>void;onToggleDensity:()=>void;
  realEnabled?:boolean;onRealTrial:()=>void;gallery:RefObject<HTMLDivElement|null>;onScroll:(top:number)=>void;actions:OverviewActions;
}) {
  const round=data.round!,summary=data.summary!,editable=!['queued','running','submitting','submitted'].includes(round.status);
  const attention=summary.qualityPhotos+summary.failedPhotos;
  const summaryTitle=working?(summary.total?`已定位${summary.total}件 · 已完成${summary.completed}件`:'正在定位元件'):summary.verdict?`${summary.completed}件检测完成`:attention&&!summary.pendingPhotos?`还有${attention}张照片需处理`:summary.completed?`${summary.completed}件已完成 · ${summary.pendingPhotos}张待检测`:`${round.photos.length}张照片 · ${summary.pendingPhotos}张待检测`;
  const visible=round.photos.filter(p=>filter==='all'||(filter==='fail'?p.components.some(c=>finalVerdict(c)==='FAIL'):['quality','error'].includes(p.status)));
  const title=working?'正在检测':round.status==='submitted'?'结果已保存':!round.photos.length?'添加待检照片':'照片总览';
  const tools=[...(editable&&realEnabled&&data.task.trialPhoto?[{label:'添加模拟拍摄照片（真实识别）',onSelect:onRealTrial,disabled:busy}]:[]),...(round.photos.length?[{label:'查看完整报告',onSelect:actions.report}]:[]),...(editable?[{label:round.instruction?'修改本次检测说明':'补充本次检测说明',onSelect:actions.notes,disabled:busy},{label:'添加内置样例',onSelect:actions.samples,disabled:busy}]:[])];
  return <main className="sv-main sv-overview sv-inspection-overview">
    <div className="sv-overview-heading"><div><h1>{title}</h1>{!round.photos.length?<p>拍清每个丝印，可分次添加照片。</p>:null}</div>{tools.length?<ActionMenu label="更多" items={tools}/>:null}</div>
    {data.effective&&round.id!==data.effective.id?<div className="sv-previous-notice">第{round.number}轮重检，上次成功结果仍然有效。</div>:null}
    {round.photos.length?<>
      <section className={'sv-detection-summary'+(working?' is-running':'')} aria-live="polite" aria-atomic="true">
        <div className="sv-detection-summary-line"><strong>{summaryTitle}</strong><div>{summary.completed?<><span className="sv-count-pass">合格 {summary.pass}</span><span className={summary.fail?'sv-count-fail':''}>不合格 {summary.fail}</span></>:null}{round.instruction?<Pill>已补充检测说明</Pill>:null}</div></div>
        {working?<><progress aria-label="已定位元件的检测进度" max={summary.total||1} value={summary.total?summary.completed:undefined}/><p>逐件处理，已完成的结果可点开查看。</p></>:null}
      </section>
      {round.photos.some(p=>p.components.some(c=>(c.ai?.instructionConflicts?.length||c.ai?.instructionWarnings?.length)))?<div className="sv-photo-attention" role="status"><span>本次按优先现场说明检测，其与标准的关系需注意。请在报告中查看具体内容。</span><Btn tone="quiet" onClick={actions.report}>查看说明事项</Btn></div>:null}
      {attention?<div className="sv-photo-attention" role="status"><span>{summary.qualityPhotos?`${summary.qualityPhotos}张需要重拍`:''}{summary.failedPhotos?`${summary.qualityPhotos?' · ':''}${summary.failedPhotos}张未完成`:''}，处理完后才能提交。</span><Btn tone="quiet" onClick={()=>onFilter(filter==='attention'?'all':'attention')}>{filter==='attention'?'查看全部':'查看需处理照片'}</Btn></div>:null}
      <div className="sv-album-toolbar"><div className="sv-album-filters" role="group" aria-label="照片筛选"><Btn tone="quiet" aria-pressed={filter==='all'} onClick={()=>onFilter('all')}>全部 {round.photos.length}张</Btn>{summary.fail?<Btn tone="quiet" aria-pressed={filter==='fail'} onClick={()=>onFilter('fail')}>不合格 {summary.fail}件</Btn>:null}{attention?<Btn tone="quiet" aria-pressed={filter==='attention'} onClick={()=>onFilter('attention')}>需处理 {attention}张</Btn>:null}</div><Btn tone="quiet" className="sv-density-toggle" aria-pressed={compact} onClick={onToggleDensity}><Grid3X3 size={17}/><span>紧凑预览</span></Btn></div>
      <div className={'sv-album-scroll'+(compact?' sv-album-compact':'')} ref={gallery} onScroll={e=>onScroll(e.currentTarget.scrollTop)}><div className="sv-album-grid">{visible.map(p=>{
        const bad=p.components.filter(c=>finalVerdict(c)==='FAIL').length,good=p.components.filter(c=>finalVerdict(c)==='PASS').length,low=p.components.some(c=>c.ai&&c.ai.confidence<.8&&!c.review);
        return <article className="sv-photo-card" data-photo-id={p.id} key={p.id}><button className="sv-photo-open" aria-label={'查看照片 '+photoName(p)} onClick={()=>actions.open(p)}><div className="sv-photo-thumb"><img src={p.url} alt={p.filename} loading="lazy"/><div className="sv-photo-status"><PhotoPill photo={p}/></div></div><div className="sv-photo-caption"><h2>{photoName(p)} · {p.components.length?p.components.length+'个元件':['quality','error'].includes(p.status)?'未生成结论':'待定位'}</h2><p className={bad?'sv-text-danger':''}>{p.status==='ready'?`${good}件合格${bad?' · '+bad+'件不合格':''}${p.components.some(c=>c.review)?' · 人工已修正':''}`:p.status==='quality'?'请替换为清晰照片':p.status==='error'?'点开查看未完成原因':p.status==='running'?(p.message||'正在处理这张照片'):p.status==='queued'?'排队等待中':'待检测'}</p>{low?<small>建议按需复核</small>:null}</div></button>{editable?<div className="sv-photo-menu"><ActionMenu label={'照片 '+photoName(p)+' 更多操作'} iconOnly disabled={busy} items={[{label:'替换照片',onSelect:()=>actions.replace(p)},{label:'移除照片',onSelect:()=>actions.remove(p),danger:true}]}/></div>:null}</article>;
      })}{editable&&filter==='all'?<button className="sv-add-photo" onClick={()=>actions.add('album')} disabled={busy}><Plus size={26}/><span>添加照片</span></button>:null}</div>{!visible.length?<p className="sv-album-empty">这里没有对应的照片。<Btn tone="quiet" onClick={()=>onFilter('all')}>查看全部照片</Btn></p>:null}</div>
    </>:<div className="sv-empty-capture"><div className="sv-capture-icon"><Camera size={38}/></div><h2>开始拍摄这一批样品</h2><p>一次可拍一个或多个元件，确保丝印清晰可见。</p><div><Btn tone="primary" disabled={busy} onClick={()=>actions.add('camera')}><Camera size={20}/>拍照</Btn><Btn disabled={busy} onClick={()=>actions.add('album')}><ImagePlus size={20}/>从相册添加</Btn></div>{realEnabled&&data.task.trialPhoto?<Btn disabled={busy} onClick={onRealTrial}>使用模拟拍摄照片 · 真实识别</Btn>:<Btn tone="quiet" disabled={busy} onClick={actions.samples}>用内置预设样例试一下</Btn>}<small>{realEnabled&&data.task.trialPhoto?'照片由AI生成，点击检测后将真实调用VLM。':realEnabled?'自动定位、转正后与正品比对；内置样例仍使用预设结果。':'当前服务未启用真实识别，完整流程请使用内置样例。'}</small></div>}
  </main>;
}

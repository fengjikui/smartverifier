import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Plus, Trash2, RotateCcw, ChevronLeft, ChevronRight, Download, X, CheckCircle2, Info, AlertTriangle, LogOut } from 'lucide-react';
import { action, ApiError, imageSize, request } from './api';
import { Btn, DiffTable, Field, Modal, PhotoCrop, PhotoPill, Pill, Spinner, VerdictPill } from './ui';
import { useRoute } from './use-route';
import { finalVerdict } from '../../shared/domain';
import type { Bootstrap, ComponentResult, Photo, SampleKind, TaskView, Verdict } from '../../shared/types';

type PendingUpload={file:File;key:string;replaceId?:string};
type DialogState={type:'samples';replaceId?:string}|{type:'remove';photo:Photo}|{type:'notes'}|{type:'review';component:ComponentResult}|{type:'retest'}|{type:'original';photo:Photo}|null;
const photoName=(p:Photo)=>'P'+String(p.sequence).padStart(3,'0');
const uploadKey=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Date.now().toString(36)+'-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
const mutable=(data:TaskView|null)=>!!data?.round&&!['queued','running','submitting','submitted'].includes(data.round.status);

export function App(){
  const [boot,setBoot]=useState<Bootstrap|null>(null),[loading,setLoading]=useState(true),[data,setData]=useState<TaskView|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(''),[search,setSearch]=useState('');
  const [dialog,setDialog]=useState<DialogState>(null),[filter,setFilter]=useState(false),[pendingFiles,setPendingFiles]=useState<PendingUpload[]>([]);
  const [instruction,setInstruction]=useState(''),[verdict,setVerdict]=useState<Verdict>('PASS'),[reason,setReason]=useState('AI识别错误，人工核对后修正'),[extraReason,setExtraReason]=useState('');
  const album=useRef<HTMLInputElement>(null),camera=useRef<HTMLInputElement>(null),gallery=useRef<HTMLDivElement>(null),scroll=useRef(0),replace=useRef<string|undefined>(undefined),busyRef=useRef(false);
  const {route,navigate}=useRoute();
  function showError(e:unknown){setError((e as Error).message??'操作未完成，请重试。');if(e instanceof ApiError&&e.status===401)setBoot(null);}
  async function refreshList(){const b=await request<Bootstrap>('/bootstrap');setBoot(b);}
  useEffect(()=>{let active=true;void request<Bootstrap>('/bootstrap').then(b=>{if(active)setBoot(b);}).catch(e=>{if(active&&!(e instanceof ApiError&&e.status===401))showError(e);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  useEffect(()=>{
    if(!boot||!route.task)return;let active=true;setData(null);setError('');setFilter(false);scroll.current=0;
    void request<TaskView>('/tasks/'+route.task+'/open',{}).then(view=>{if(active)setData(view);}).catch(e=>{if(active)showError(e);});return()=>{active=false;};
  },[route.task,boot?.person.id]);
  const round=data?.round,working=!!round&&['queued','running','submitting'].includes(round.status);
  useEffect(()=>{
    if(!working||!route.task)return;let active=true;let timer:ReturnType<typeof setTimeout>;
    async function poll(){try{const v=await request<TaskView>('/tasks/'+route.task);if(active){setData(v);setNotice('');}}catch(e){if(active)setNotice('连接暂时中断，已保存的照片和结果保留，正在重新连接…');}finally{if(active)timer=setTimeout(poll,650);}}
    timer=setTimeout(poll,450);return()=>{active=false;clearTimeout(timer);};
  },[working,route.task]);
  useLayoutEffect(()=>{if((route.view??'overview')==='overview'&&gallery.current)gallery.current.scrollTop=scroll.current;},[route.view,filter,data?.task.id]);

  async function run(label:string,fn:()=>Promise<void>){
    if(busyRef.current)return;busyRef.current=true;setBusy(label);setError('');setNotice('');
    try{await fn();}catch(e){showError(e);if(e instanceof ApiError&&e.status===409&&route.task){try{setData(await request<TaskView>('/tasks/'+route.task));}catch{/* Keep the last visible draft if disconnected. */}}}finally{busyRef.current=false;setBusy('');}
  }
  function taskList(){setData(null);setDialog(null);navigate({});void refreshList().catch(showError);}
  function overview(){navigate({task:route.task,view:'overview'},true);}
  function openPhoto(photo:Photo,component?:ComponentResult,replaceHistory=false){
    if(!photo.components.some(c=>c.ai)){setDialog({type:'original',photo});return;}
    if(gallery.current)scroll.current=gallery.current.scrollTop;
    navigate({task:route.task,view:'detail',photo:photo.id,component:(component??photo.components.find(c=>c.ai))?.id},replaceHistory);
  }
  function picker(kind:'camera'|'album',replaceId?:string){replace.current=replaceId;(kind==='camera'?camera:album).current?.click();}
  async function upload(items:PendingUpload[]){
    if(!data?.round)return;let view=data;
    for(let i=0;i<items.length;i++){
      const item=items[i];setPendingFiles(items.slice(i));setBusy(`正在保存照片 ${i+1}/${items.length}…`);
      if(item.file.size>20*1024*1024)throw new Error(item.file.name+' 超过20MB，请选择较小的原始照片。');
      const size=await imageSize(item.file),form=new FormData();form.set('photo',item.file);form.set('width',String(size.width));form.set('height',String(size.height));form.set('revision',String(view.round!.revision));form.set('clientId',item.key);if(item.replaceId)form.set('replaceId',item.replaceId);
      view=await request<TaskView>('/rounds/'+view.round!.id+'/photos',form);setData(view);setPendingFiles(items.slice(i+1));
    }
    setDialog(null);overview();setNotice('照片已保存。真实照片将在下一阶段接入模型后识别；本阶段可使用内置样例体验完整流程。');
  }
  function filesPicked(files:FileList|null){if(!files?.length)return;const items=Array.from(files).slice(0,replace.current?1:undefined).map(file=>({file,key:uploadKey(),replaceId:replace.current}));replace.current=undefined;setPendingFiles(items);void run('正在保存照片…',()=>upload(items));}
  async function update(name:string,values:Record<string,unknown>={}){if(data){const next=await action(data,name,values);setData(next);if(filter&&!next.summary?.fail)setFilter(false);}}
  const selectedPhoto=round?.photos.find(p=>p.id===route.photo),selectedComponent=selectedPhoto?.components.find(c=>c.id===route.component)??selectedPhoto?.components.find(c=>c.ai);
  const summary=data?.summary,locked=!!busy||working||round?.status==='submitted';

  if(loading)return <div className="sv-loading"><Spinner/>正在打开检验工作台…</div>;
  if(!boot)return <div className="sv-login">
    <section className="sv-login-brand"><img src="/assets/login-scan.svg" width="48" height="48" alt=""/><h1>观微</h1><h2>让每一次丝印检验，<br/>清楚、有据可查。</h2><div className="sv-login-spacer"/><p>拍照检测 / 自动比对 / MES 回填</p><small>丝印检测工作台</small></section>
    <section className="sv-login-content"><img src="/assets/login-shield.svg" width="36" height="36" alt=""/><h2>登录检验工作台</h2><p>从拍照到结果保存，在平板上轻松完成。</p><Pill tone="warning">第一阶段 · 本地流程试用</Pill>
      <Btn tone="primary" disabled={!!busy} onClick={()=>void run('正在进入…',async()=>{setBoot(await request<Bootstrap>('/session',{}));})}>{busy?<Spinner/>:null}进入本地试用</Btn>
      <p className="sv-description">当前使用模拟身份、内置样例结果和模拟MES，未连接公司系统。可保存自己的照片；完整流程请先使用内置样例。</p><hr/><small>华为平板 · 横屏优先 · 支持中途继续</small>{error?<p className="sv-error" role="alert">{error}</p>:null}
    </section>
  </div>;

  const mainView=route.view??'overview';
  return <div className="sv-app">
    <header className="sv-header">{route.task?<Btn className="sv-back" onClick={mainView==='overview'?taskList:overview}><ChevronLeft size={18}/>返回</Btn>:<img src="/assets/tasks-scan.svg" width="30" height="30" alt=""/>}<strong className="sv-brand">观微</strong><span className="sv-product">丝印检测</span><span className="sv-location">{data?.task.number??'检验任务'}</span><Pill>本地流程试用</Pill><span className="sv-person">{boot.person.name} · {boot.person.id}</span><Btn tone="quiet" className="sv-icon-button" aria-label="退出本地试用" onClick={()=>void run('正在退出…',async()=>{await request('/session',{},'DELETE');setBoot(null);setData(null);navigate({},true);})}><LogOut size={18}/></Btn></header>
    {error?<div className="sv-message error" role="alert"><AlertTriangle size={20}/><span>{error}</span><Btn tone="quiet" className="sv-icon-button" aria-label="关闭错误提示" onClick={()=>setError('')}><X size={18}/></Btn></div>:null}
    {notice?<div className="sv-message" role="status"><Info size={18}/><span>{notice}</span><Btn tone="quiet" className="sv-icon-button" aria-label="关闭提示" onClick={()=>setNotice('')}><X size={18}/></Btn></div>:null}
    {busy?<div className="sv-busy" role="status"><Spinner/>{busy}</div>:null}
    {!route.task?<>
      <main className="sv-main sv-tasks"><div className="sv-heading"><h1>选择检验任务</h1><p>按任务单号、物料或供应商，快速找到本次检验。</p></div><label className="sv-field">关键词查询<Field value={search} placeholder="搜索单号末几位 / 物料编号 / 供应商" onChange={e=>setSearch(e.target.value)}/></label>
        <section className="sv-panel sv-task-list"><div className="sv-task-table-head"><span>检验任务</span><span>状态</span><span>操作</span></div>
          {boot.tasks.filter(t=>[t.number,t.material,t.supplier].some(x=>x.toLowerCase().includes(search.trim().toLowerCase()))).map(t=><article className="sv-task-row" key={t.id}><div><h2>{t.number}</h2><p>{t.material} · {t.supplier}</p></div><div><Pill tone={!t.standard?'warning':'neutral'}>{t.status}</Pill></div><Btn disabled={!!busy} onClick={()=>navigate({task:t.id})}>{t.effectiveRoundId?'查看结果':t.roundId?'继续检验':'进入任务'}</Btn></article>)}
          {!boot.tasks.some(t=>[t.number,t.material,t.supplier].some(x=>x.toLowerCase().includes(search.trim().toLowerCase())))?<p className="sv-empty-search">没有找到对应任务，试试单号末几位。</p>:null}
        </section><p className="sv-description">共{boot.tasks.length}项模拟任务 · 草稿与结果由本机服务保存</p>
      </main><footer className="sv-footer"><FooterNote title={boot.person.name+' · '+boot.person.id}/></footer>
    </>:!data?<main className="sv-main sv-loading"><Spinner/>正在读取检验任务…</main>:!data.task.standard?<>
      <main className="sv-main sv-centered"><AlertTriangle size={40} className="sv-warning-icon"/><h1>缺少正品基准，请联系管理员</h1><p>{data.task.material} · {data.task.supplier}</p><p className="sv-description">管理员补齐对应标准后即可继续，检验员无需上传正品图片。</p></main><footer className="sv-footer"><FooterNote title="本任务暂时不能检测"/><Btn tone="primary" onClick={taskList}>返回任务列表</Btn></footer>
    </>:!round?<main className="sv-main sv-loading"><Spinner/>正在准备本轮检测…</main>:mainView==='transfer'?<>
      <main className="sv-main sv-centered">{round.status==='submitting'?<><Spinner/><h1>正在保存到模拟MES</h1><p>请稍候，照片和检测结果已经保留。</p></>:round.transfer?.status==='success'?<><CheckCircle2 size={52} className="sv-success-icon"/><h1>已保存到模拟MES</h1><p>本轮{summary?.total}件 · {summary?.verdict==='PASS'?'合格':'不合格'} · 不良数{summary?.fail}</p><p className="sv-description">仅模拟保存丝印检测项，未连接公司MES。</p><section className="sv-panel sv-receipt"><span>检验单号</span><strong>{data.task.number}</strong><span>保存回执</span><code>{round.transfer.receipt}</code><span>操作人员</span><strong>{boot.person.name} · {boot.person.id}</strong></section></>:<><AlertTriangle size={48} className="sv-warning-icon"/><h1>回填没有完成</h1><p>{round.transfer?.message??'结果已保留，请重新提交。'}</p><p className="sv-description">{data.effective?'上次成功保存的结果仍然有效。':'当前尚无成功保存的结果。'}</p></>}</main>
      <footer className="sv-footer"><FooterNote title={round.status==='submitting'?'正在确认保存结果':round.transfer?.status==='success'?'照片与图文报告已关联本轮结果':'检测内容已保留，可安全重试'}/><Btn disabled={working} onClick={overview}>查看本次结果</Btn>{round.transfer?.status==='success'?<Btn tone="primary" onClick={taskList}>返回任务列表</Btn>:<Btn tone="primary" disabled={working||!!busy} onClick={()=>void run('正在重新回填…',()=>update('submit'))}>{working?<Spinner/>:null}{working?'正在保存':'重试回填'}</Btn>}</footer>
    </>:mainView==='detail'&&selectedPhoto&&selectedComponent?.ai?<>
      <main className="sv-main sv-detail"><div className="sv-heading"><h1>照片 {photoName(selectedPhoto)} · 元件 {selectedComponent.index+1} · {finalVerdict(selectedComponent)==='PASS'?'合格':'不合格'}</h1><p>{selectedComponent.ai.reason}</p></div>
        <div className="sv-detail-nav"><span>这张照片中的{selectedPhoto.components.length}个元件</span><div className="sv-component-tabs">{selectedPhoto.components.map(c=><Btn key={c.id} className={c.id===selectedComponent.id?'selected':''} onClick={()=>openPhoto(selectedPhoto,c,true)}>{String(c.index+1).padStart(2,'0')} {finalVerdict(c)==='FAIL'?'×':c.ai&&c.ai.confidence<.8?'!':'✓'}</Btn>)}</div></div>
        <div className="sv-compare"><section className="sv-panel"><h2>待检元件</h2><div className="sv-photo-stage"><PhotoCrop photo={selectedPhoto} component={selectedComponent}/></div></section><section className="sv-panel"><h2>正品基准</h2><div className="sv-photo-stage"><img className="sv-reference" src={round.standard.image} alt="本轮采用的正品基准"/></div></section></div>
        <DiffTable expected={round.standard.lines} actual={selectedComponent.ai.lines} reason={selectedComponent.review?'AI原识别文字保留；本轮按人工核对结果汇总。':selectedComponent.ai.reason}/>
        <section className="sv-panel sv-evidence"><VerdictPill verdict={finalVerdict(selectedComponent)}/><span>AI判断把握 {Math.round(selectedComponent.ai.confidence*100)}%（样例预设）</span>{selectedComponent.ai.confidence<.8?<Pill tone="warning">建议复核，非必经步骤</Pill>:null}<Btn tone="quiet" onClick={()=>setDialog({type:'original',photo:selectedPhoto})}>查看照片 {photoName(selectedPhoto)} 原图</Btn>
          {selectedComponent.review?<p className="sv-review-record">人工已修正：{selectedComponent.review.person.name} · {new Date(selectedComponent.review.at).toLocaleString('zh-CN')} · {selectedComponent.review.reason}。AI原判{selectedComponent.ai.verdict==='PASS'?'合格':'不合格'}已保留。</p>:null}
        </section><div className="sv-photo-navigation"><Btn onClick={()=>{const i=round.photos.indexOf(selectedPhoto);if(i>0)openPhoto(round.photos[i-1],undefined,true);}} disabled={round.photos.indexOf(selectedPhoto)===0}><ChevronLeft size={18}/>上一张照片</Btn><Btn disabled={round.photos.indexOf(selectedPhoto)===round.photos.length-1} onClick={()=>{const i=round.photos.indexOf(selectedPhoto);openPhoto(round.photos[i+1],undefined,true);}}>下一张照片<ChevronRight size={18}/></Btn></div>
      </main><footer className="sv-footer"><FooterNote title="人工复核可选，保持当前结论可直接返回"/>{mutable(data)?<Btn disabled={!!busy} onClick={()=>{setVerdict(finalVerdict(selectedComponent)??'PASS');setReason('AI识别错误，人工核对后修正');setExtraReason('');setDialog({type:'review',component:selectedComponent});}}>修正结论</Btn>:null}<Btn tone="primary" onClick={overview}>返回照片总览</Btn></footer>
    </>:mainView==='report'?<>
      <main className="sv-main sv-report"><div className="sv-heading"><h1>丝印检测报告</h1><p>{data.task.number} · 第{round.number}轮 · {boot.person.name} {boot.person.id}</p></div>
        <section className="sv-panel sv-report-summary"><VerdictPill verdict={summary?.verdict??null}/><div><h2>已检测{summary?.completed}件 · 合格{summary?.pass}件 · 不合格{summary?.fail}件</h2><p>采用正品标准 v{round.standard.version} · 检测说明 v{round.instructionVersion}</p></div><a className="sv-download" href={'/api/rounds/'+round.id+'/report.md'}><Download size={18}/>下载报告</a></section>
        {round.instruction?<section className="sv-panel sv-instruction-report"><h2>现场检测说明（本次优先）</h2><p>{round.instruction}</p><small>当前模拟样例不执行自然语言判断，语义理解将在真实模型阶段验证。</small></section>:null}
        {round.photos.map(p=><section key={p.id} className="sv-report-photo"><h2>照片 {photoName(p)} · {p.components.length}个元件</h2><div className="sv-report-original"><img src={p.url} alt={'原始照片 '+photoName(p)} onClick={()=>setDialog({type:'original',photo:p})}/>{p.sample==='four'?<div className="sv-sample-annotations">{[0,1,2,3].map(i=><img key={i} src={'/assets/report-frame'+(i?i:'')+'.svg'} width="626" height="310" alt=""/>)}{p.components.map(c=><span key={c.id} className={'sv-sample-label label-'+c.index}>{String(c.index+1).padStart(2,'0')}</span>)}</div>:null}</div>
          {p.components.filter(c=>c.ai).map(c=><div key={c.id} className="sv-report-component"><div className="sv-report-component-heading"><h3>{c.label}</h3><VerdictPill verdict={finalVerdict(c)}/>{c.review?<Pill>人工已修正</Pill>:null}</div><DiffTable expected={round.standard.lines} actual={c.ai!.lines} title="丝印文字对照" reason={c.review?'AI原识别差异保留；最终以人工核对结果为准。':c.ai!.reason}/>{c.review?<p className="sv-review-record">{c.review.person.name} · {c.review.reason} · AI原判{c.ai!.verdict==='PASS'?'合格':'不合格'}保留</p>:null}</div>)}{p.message?<p>{p.message}</p>:null}
        </section>)}<section className="sv-panel"><h2>检测依据与追溯信息</h2><p>{round.standard.description}</p><p className="sv-description">本阶段识别为预设样例；原图、AI原判、人工修正人员和原因均保留。报告中的颜色可在本页面查看，Markdown附件同时保留原文及差异说明。</p></section>
      </main><footer className="sv-footer"><FooterNote title="图文报告可上下滚动查看"/><Btn tone="primary" onClick={overview}>返回照片总览</Btn></footer>
    </>:<>
      <main className="sv-main sv-overview"><div className="sv-heading"><h1>{working?'正在检测':round.status==='submitted'?'本轮结果已保存':round.photos.length===0?'开始拍摄':summary?.canSubmit?'本次检测完成':'照片预览'}</h1><p>{working?'照片保持清晰，已完成的结果会陆续出现。':round.photos.length===0?'拍清丝印，可分次添加照片，准备好后开始检测。':'上下浏览照片，点开查看详情；人工复核是可选操作。'}</p></div>
        {data.effective&&round.id!==data.effective.id?<div className="sv-previous-notice">正在第{round.number}轮重检，上次成功结果仍然有效，新结果成功保存后才替换。</div>:null}
        {round.photos.length?<><section className="sv-progress-summary" aria-live="polite"><div><strong>{summary?.completed??0}件已完成 · {summary?.pass??0}件合格 · {summary?.fail??0}件不合格</strong>{working?<p>{summary?.total?`已定位${summary.total}件元件，逐件处理中`:'正在定位元件…'}</p>:summary?.qualityPhotos||summary?.failedPhotos?<p>{summary.qualityPhotos}张需重拍 · {summary.failedPhotos}张尚未完成</p>:null}</div>{summary?.fail?<Btn onClick={()=>{scroll.current=0;setFilter(!filter);}}>{filter?'查看全部照片':'仅看不合格 '+summary.fail}</Btn>:null}<Btn onClick={()=>navigate({task:route.task,view:'report'})}>检测报告</Btn></section>
          <div className="sv-album-toolbar"><span>拍摄顺序 · {round.photos.length}张照片</span><div>{mutable(data)?<Btn tone="quiet" disabled={!!busy} onClick={()=>{setInstruction(round.instruction);setDialog({type:'notes'});}}>本次检测说明{round.instruction?' · 已补充':''}</Btn>:null}<small>✓ 合格　× 不合格　! 建议复核</small></div></div>
          <div className="sv-album-scroll" ref={gallery} onScroll={e=>{scroll.current=e.currentTarget.scrollTop;}}><div className="sv-album-grid">{round.photos.filter(p=>!filter||p.components.some(c=>finalVerdict(c)==='FAIL')).map(p=>{
            const bad=p.components.filter(c=>finalVerdict(c)==='FAIL').length,good=p.components.filter(c=>finalVerdict(c)==='PASS').length,low=p.components.some(c=>c.ai&&c.ai.confidence<.8&&!c.review);
            return <article className="sv-photo-card" key={p.id}><button className="sv-photo-open" aria-label={'查看照片 '+photoName(p)} onClick={()=>openPhoto(p)}><div className="sv-photo-thumb"><img src={p.url} alt={p.filename} loading="lazy"/><div className="sv-photo-status"><PhotoPill photo={p}/></div>{low?<span className="sv-low-confidence" aria-label="建议复核"><img src="/assets/album-alert.svg" width="24" height="24" alt="建议复核"/></span>:null}</div><div className="sv-photo-caption"><h2>{photoName(p)} · {p.components.length?p.components.length+'个元件':'待定位'}</h2><p className={bad?'sv-text-danger':''}>{p.status==='ready'?`${good}件合格${bad?' · '+bad+'件不合格':''}${p.components.some(c=>c.review)?' · 人工已修正':''}`:p.status==='quality'?'图片质量过低，请重新拍照':p.status==='error'?'未生成结论，请查看说明':p.status==='running'?'正在处理这张照片':p.status==='queued'?'等待前面的照片完成':'准备好后点击检测'}</p>{low?<small>建议按需复核反光字符</small>:null}</div></button>{mutable(data)?<div className="sv-photo-actions"><Btn tone="quiet" disabled={!!busy} onClick={()=>picker('album',p.id)}><RotateCcw size={16}/>替换照片</Btn><Btn tone="quiet" className="sv-icon-button" disabled={!!busy} aria-label={'移除照片 '+photoName(p)} onClick={()=>setDialog({type:'remove',photo:p})}><Trash2 size={18}/></Btn></div>:null}</article>;
          })}{mutable(data)&&!filter?<button className="sv-add-photo" onClick={()=>picker('album')} disabled={!!busy}><Plus size={28}/><span>继续添加照片</span></button>:null}</div></div>
        </>:<div className="sv-empty-capture"><div className="sv-capture-icon"><Camera size={40}/></div><h2>先拍清楚，再交给系统</h2><p>一次可拍一个或多个元件，请确保每个丝印清晰可见。</p><div><Btn tone="primary" disabled={!!busy} onClick={()=>picker('camera')}><Camera size={20}/>拍照</Btn><Btn disabled={!!busy} onClick={()=>picker('album')}><ImagePlus size={20}/>从相册添加</Btn></div><Btn tone="quiet" disabled={!!busy} onClick={()=>setDialog({type:'samples'})}>用内置样例试一下</Btn><small>当前未接真实模型，内置样例用于完整流程体验。</small></div>}
        {pendingFiles.length?<div className="sv-upload-retry" role="status">还有{pendingFiles.length}张照片未确认保存。<Btn disabled={!!busy} onClick={()=>void run('正在重试上传…',()=>upload(pendingFiles))}>重试保存</Btn><Btn tone="quiet" disabled={!!busy} onClick={()=>setPendingFiles([])}>取消待上传照片</Btn></div>:null}
      </main><footer className="sv-footer"><FooterNote title={round.photos.length?`本轮${summary?.total??0}件 · 不良数${summary?.fail??0}${summary?.lowConfidence?' · '+summary.lowConfidence+'件建议复核':''}`:'正品基准已关联 · '+data.task.material}/>
        {round.status==='submitted'?<Btn disabled={!!busy} onClick={()=>setDialog({type:'retest'})}>重新检测</Btn>:round.photos.length?<><Btn disabled={locked} onClick={()=>picker('camera')}><Camera size={20}/>继续拍照</Btn><Btn className="sv-add-sample-secondary" disabled={locked} onClick={()=>setDialog({type:'samples'})}>添加样例</Btn></>:null}
        {round.status==='submitted'?<Btn tone="primary" onClick={taskList}>返回任务列表</Btn>:summary?.canSubmit?<Btn tone="primary" disabled={!!busy||pendingFiles.length>0} onClick={()=>void run('正在发起回填…',async()=>{await update('submit');navigate({task:route.task,view:'transfer'});})}>提交到模拟MES</Btn>:<Btn tone="primary" disabled={locked||!round.photos.length||pendingFiles.length>0} onClick={()=>void run('正在加入检测队列…',()=>update('analyze'))}>{working?<Spinner/>:null}{working?'正在检测':summary?.completed?'检测未完成部分':'开始检测'}</Btn>}
      </footer>
    </>}
    <input ref={album} tabIndex={-1} aria-hidden="true" className="sv-file-input" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e=>{filesPicked(e.target.files);e.target.value='';}}/><input ref={camera} tabIndex={-1} aria-hidden="true" className="sv-file-input" type="file" accept="image/*" capture="environment" onChange={e=>{filesPicked(e.target.files);e.target.value='';}}/>
    {dialog?.type==='samples'?<Modal title={dialog.replaceId?'用样例替换这张照片':'选择一种内置样例'} description="这些图片及检测结果为虚构预设，仅用于体验流程，不代表真实识别效果。" onClose={()=>{if(!busy)setDialog(null);}}><div className="sv-sample-options">{([['four','四个元件','3件合格、1件不合格，含建议复核'],['pass','一个合格元件','体验正常合格与增量检测'],['fail','一个不合格元件','体验字符错序与人工修正'],['quality','需要重拍的状态','体验质量提示及提交阻断']] as [SampleKind,string,string][]).map(([sample,title,sub])=><Btn key={sample} disabled={!!busy} onClick={()=>void run('正在添加样例…',async()=>{await update('sample',{sample,replaceId:dialog.replaceId});setDialog(null);overview();})}><strong>{title}</strong><span>{sub}</span></Btn>)}</div></Modal>:null}
    {dialog?.type==='remove'?<Modal title={'移除照片 '+photoName(dialog.photo)+'？'} description={`该照片及其${dialog.photo.components.length}件元件的结果会从本轮移除，已提交历史不受影响。`} onClose={()=>{if(!busy)setDialog(null);}} actions={<><Btn disabled={!!busy} onClick={()=>setDialog(null)}>保留照片</Btn><Btn tone="danger" disabled={!!busy} onClick={()=>void run('正在移除…',async()=>{await update('remove',{photoId:dialog.photo.id});setDialog(null);})}>确认移除</Btn></>}/>:null}
    {dialog?.type==='notes'?<Modal title="本次检测说明" description="补充此次任务的要求。保存后，已有元件也需要按最新说明重新判定，不必重拍。" onClose={()=>{if(!busy)setDialog(null);}} actions={<><Btn disabled={!!busy} onClick={()=>setDialog(null)}>取消</Btn><Btn tone="primary" disabled={!!busy} onClick={()=>void run('正在保存说明…',async()=>{await update('notes',{instruction});setDialog(null);setNotice('说明已保存，请点击检测。当前样例仅模拟重新判定流程，暂不执行自然语言要求。');})}>保存说明</Btn></>}><label className="sv-field">现场补充说明<textarea value={instruction} maxLength={4000} onChange={e=>setInstruction(e.target.value)} rows={5} placeholder="例如：本批次的日期码允许变化，重点核对型号。可用系统输入法语音输入。"/></label><p className="sv-description">本次说明随报告保留，优先于通用说明，不会修改正品数据库。</p></Modal>:null}
    {dialog?.type==='review'?<Modal title="修正元件结论" description="以人工核对后的结果为准，AI原判、修改人和原因会保留。" onClose={()=>{if(!busy)setDialog(null);}} actions={<><Btn disabled={!!busy} onClick={()=>setDialog(null)}>取消</Btn><Btn tone="primary" disabled={!!busy||!(reason+extraReason).trim()} onClick={()=>void run('正在保存修正…',async()=>{await update('review',{componentId:dialog.component.id,verdict,reason:[reason,extraReason].filter(Boolean).join('；')});setDialog(null);})}>保存修正</Btn></>}><fieldset className="sv-verdict-options"><legend>人工核对结论</legend>{(['PASS','FAIL'] as Verdict[]).map(v=><label key={v}><input type="radio" name="verdict" checked={verdict===v} onChange={()=>setVerdict(v)}/>{v==='PASS'?'合格':'不合格'}</label>)}</fieldset><label className="sv-field">修改原因<select value={reason} onChange={e=>setReason(e.target.value)}><option>AI识别错误，人工核对后修正</option><option>已核对实物，按现场标准修正</option><option>图片反光或模糊导致误判</option><option value="">其他原因（请补充）</option></select></label><label className="sv-field">补充说明（可选）<textarea value={extraReason} maxLength={800} onChange={e=>setExtraReason(e.target.value)} rows={3} placeholder="可使用系统输入法语音补充"/></label></Modal>:null}
    {dialog?.type==='retest'?<Modal title="开始新一轮检测" description="上次成功保存的结果仍然有效，新一轮成功回填后再替换。历史照片与人工记录不会删除。" onClose={()=>{if(!busy)setDialog(null);}} actions={<><Btn disabled={!!busy} onClick={()=>void run('正在准备新一轮…',async()=>{setData(await request<TaskView>('/tasks/'+data!.task.id+'/rounds',{reuse:false}));setDialog(null);overview();})}>重新拍摄</Btn><Btn tone="primary" disabled={!!busy} onClick={()=>void run('正在复用照片…',async()=>{setData(await request<TaskView>('/tasks/'+data!.task.id+'/rounds',{reuse:true}));setDialog(null);overview();})}>复用上一轮照片</Btn></>}/>:null}
    {dialog?.type==='original'?<Modal title={'照片 '+photoName(dialog.photo)+' 原图'} description={dialog.photo.message||'保留原始照片，可用浏览器或系统手势放大查看。'} onClose={()=>setDialog(null)} actions={<>{mutable(data)?<Btn disabled={!!busy} onClick={()=>{const id=dialog.photo.id;setDialog(null);setDialog({type:'samples',replaceId:id});}}>用样例替换</Btn>:null}<a className="sv-download" href={dialog.photo.url} target="_blank" rel="noreferrer">打开完整原图</a><Btn tone="primary" onClick={()=>setDialog(null)}>返回</Btn></>}><img className="sv-original-image" src={dialog.photo.url} alt={dialog.photo.filename}/>{mutable(data)?<Btn disabled={!!busy} onClick={()=>{const id=dialog.photo.id;setDialog(null);picker('camera',id);}}>重新拍照并替换</Btn>:null}</Modal>:null}
  </div>;
}

function FooterNote({title}:{title:string}){return <div className="sv-footer-note"><strong>{title}</strong><span>只回填丝印检测项 · 检验单仍在MES最终确认</span></div>;}

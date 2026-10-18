import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, ChevronLeft, X, Info, AlertTriangle, LogOut } from 'lucide-react';
import { action, ApiError, imageSize, request } from './api';
import { Btn, Modal, Pill, Spinner } from './ui';
import { useRoute } from './use-route';
import { finalVerdict, hasRealRecognition } from '../../shared/domain';
import { InspectionDetail } from './inspection-detail';
import { useAlbumDensity } from './use-album-density';
import { InspectionReport } from './inspection-report';
import { TaskSelection } from './task-selection';
import { InspectionOverview } from './inspection-overview';
import type { AlbumFilter } from './inspection-overview';
import { InspectionTransfer } from './inspection-transfer';
import type { Bootstrap, ComponentResult, Photo, SampleKind, TaskView, Verdict } from '../../shared/types';

type PendingUpload={file:File;key:string;replaceId?:string};
type DialogState={type:'samples';replaceId?:string}|{type:'remove';photo:Photo}|{type:'notes'}|{type:'review';component:ComponentResult}|{type:'retest'}|{type:'original';photo:Photo}|null;
const photoName=(p:Photo)=>'P'+String(p.sequence).padStart(3,'0');
const uploadKey=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Date.now().toString(36)+'-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
const mutable=(data:TaskView|null)=>!!data?.round&&!['queued','running','submitting','submitted'].includes(data.round.status);

export function App(){
  const [boot,setBoot]=useState<Bootstrap|null>(null),[loading,setLoading]=useState(true),[data,setData]=useState<TaskView|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(''),[search,setSearch]=useState('');
  const [dialog,setDialog]=useState<DialogState>(null),[filter,setFilter]=useState<AlbumFilter>('all'),[pendingFiles,setPendingFiles]=useState<PendingUpload[]>([]);
  const [imageView,setImageView]=useState<'original'|'annotated'|'sheet'>('original'),[instruction,setInstruction]=useState(''),[verdict,setVerdict]=useState<Verdict>('PASS'),[reason,setReason]=useState('AI识别错误，人工核对后修正'),[extraReason,setExtraReason]=useState('');
  const album=useRef<HTMLInputElement>(null),camera=useRef<HTMLInputElement>(null),gallery=useRef<HTMLDivElement>(null),scroll=useRef(0),replace=useRef<string|undefined>(undefined),busyRef=useRef(false);
  const {route,navigate}=useRoute();
  const density=useAlbumDensity(gallery,scroll,route.task);
  function showError(e:unknown){setError((e as Error).message??'操作未完成，请重试。');if(e instanceof ApiError&&e.status===401)setBoot(null);}
  async function refreshList(){const b=await request<Bootstrap>('/bootstrap');setBoot(b);}
  useEffect(()=>{let active=true;void request<Bootstrap>('/bootstrap').then(b=>{if(active)setBoot(b);}).catch(e=>{if(active&&!(e instanceof ApiError&&e.status===401))showError(e);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  useEffect(()=>{
    if(!boot||!route.task)return;let active=true;setData(null);setError('');setFilter('all');scroll.current=0;
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
    setImageView('original');
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
    setDialog(null);overview();setNotice(hasRealRecognition(boot?.recognition)?'照片已保存，点击开始检测即可自动定位并与正品比对。':'照片已保存。当前服务未启用真实识别，可使用内置样例体验流程。');
  }
  function filesPicked(files:FileList|null){if(!files?.length)return;const items=Array.from(files).slice(0,replace.current?1:undefined).map(file=>({file,key:uploadKey(),replaceId:replace.current}));replace.current=undefined;setPendingFiles(items);void run('正在保存照片…',()=>upload(items));}
  async function update(name:string,values:Record<string,unknown>={}){if(data){const next=await action(data,name,values);setData(next);if((filter==='fail'&&!next.summary?.fail)||(filter==='attention'&&!next.summary?.qualityPhotos&&!next.summary?.failedPhotos))setFilter('all');}}
  const selectedPhoto=round?.photos.find(p=>p.id===route.photo),selectedComponent=selectedPhoto?.components.find(c=>c.id===route.component)??selectedPhoto?.components.find(c=>c.ai);
  const summary=data?.summary,locked=!!busy||working||round?.status==='submitted';

  if(loading)return <div className="sv-loading"><Spinner/>正在打开检验工作台…</div>;
  if(!boot)return <div className="sv-login">
    <section className="sv-login-brand"><img src="/assets/login-scan.svg" width="48" height="48" alt=""/><h1>观微</h1><h2>让每一次丝印检验，<br/>清楚、有据可查。</h2><div className="sv-login-spacer"/><p>拍照检测 / 自动比对 / MES 回填</p><small>丝印检测工作台</small></section>
    <section className="sv-login-content"><img src="/assets/login-shield.svg" width="36" height="36" alt=""/><h2>登录检验工作台</h2><p>从拍照到结果保存，在平板上轻松完成。</p><Pill tone="warning">本机开发试用</Pill>
      <Btn tone="primary" disabled={!!busy} onClick={()=>void run('正在进入…',async()=>{setBoot(await request<Bootstrap>('/session',{}));})}>{busy?<Spinner/>:null}进入本地试用</Btn>
      <p className="sv-description">支持配置的 VLM 服务识别。身份及MES仍为模拟，未连接公司系统；任务内会标明照片和结果来源。</p><hr/><small>华为平板 · 横屏优先 · 支持中途继续</small>{error?<p className="sv-error" role="alert">{error}</p>:null}
    </section>
  </div>;

  const mainView=route.view??'overview';
  return <div className="sv-app">
    <header className="sv-header">{route.task?<Btn className="sv-back" onClick={mainView==='overview'?taskList:overview}><ChevronLeft size={18}/>返回</Btn>:<img src="/assets/tasks-scan.svg" width="30" height="30" alt=""/>}<strong className="sv-brand">观微</strong><span className="sv-product">丝印检测</span><span className="sv-location">{data?.task.number??'检验任务'}</span><Pill>{hasRealRecognition(boot.recognition)?'VLM真实识别 · MES模拟':'本地流程试用'}</Pill><span className="sv-person">{boot.person.name} · {boot.person.id}</span><Btn tone="quiet" className="sv-icon-button" aria-label="退出本地试用" onClick={()=>void run('正在退出…',async()=>{await request('/session',{},'DELETE');setBoot(null);setData(null);navigate({},true);})}><LogOut size={18}/></Btn></header>
    {error?<div className="sv-message error" role="alert"><AlertTriangle size={20}/><span>{error}</span><Btn tone="quiet" className="sv-icon-button" aria-label="关闭错误提示" onClick={()=>setError('')}><X size={18}/></Btn></div>:null}
    {notice?<div className="sv-message" role="status"><Info size={18}/><span>{notice}</span><Btn tone="quiet" className="sv-icon-button" aria-label="关闭提示" onClick={()=>setNotice('')}><X size={18}/></Btn></div>:null}
    {busy?<div className="sv-busy" role="status"><Spinner/>{busy}</div>:null}
    {!route.task?<TaskSelection tasks={boot.tasks} search={search} onSearch={setSearch} onOpen={id=>navigate({task:id})} busy={!!busy}/>
    :!data?<main className="sv-main sv-loading"><Spinner/>正在读取检验任务…</main>:!data.task.standard?<>
      <main className="sv-main sv-centered"><AlertTriangle size={40} className="sv-warning-icon"/><h1>缺少正品基准，请联系管理员</h1><p>{data.task.material} · {data.task.supplier}</p><p className="sv-description">管理员补齐对应标准后即可继续，检验员无需上传正品图片。</p></main><footer className="sv-footer"><FooterNote title="本任务暂时不能检测"/><Btn tone="primary" onClick={taskList}>返回任务列表</Btn></footer>
    </>:!round?<main className="sv-main sv-loading"><Spinner/>正在准备本轮检测…</main>:mainView==='transfer'?<>
      <InspectionTransfer data={data} person={boot.person}/>
      <footer className="sv-footer"><FooterNote title={round.status==='submitting'?'正在确认保存结果':round.transfer?.status==='success'?'照片与图文报告已关联本轮结果':'检测内容已保留，可安全重试'}/><Btn disabled={working} onClick={overview}>查看本次结果</Btn>{round.transfer?.status==='success'?<Btn tone="primary" onClick={taskList}>返回任务列表</Btn>:<Btn tone="primary" disabled={working||!!busy} onClick={()=>void run('正在重新回填…',()=>update('submit'))}>{working?<Spinner/>:null}{working?'正在保存':'重试回填'}</Btn>}</footer>
    </>:mainView==='detail'&&selectedPhoto&&selectedComponent?.ai?<>
      <InspectionDetail round={round} photo={selectedPhoto} component={selectedComponent} onSelect={(photo,component)=>openPhoto(photo,component,true)} onOriginal={()=>{setImageView('original');setDialog({type:'original',photo:selectedPhoto});}}/>
      <footer className="sv-footer"><FooterNote title={`本轮${summary?.total??0}件 · 不合格${summary?.fail??0}件`}/>{mutable(data)?<Btn tone="quiet" disabled={!!busy} onClick={()=>{setVerdict(finalVerdict(selectedComponent)??'PASS');setReason('AI识别错误，人工核对后修正');setExtraReason('');setDialog({type:'review',component:selectedComponent});}}>修正结论</Btn>:null}<Btn tone="primary" onClick={overview}>返回照片总览</Btn></footer>
    </>:mainView==='report'?<>
      <InspectionReport key={round.id} round={round} summary={summary} task={data.task} person={boot.person} onOriginal={photo=>{setImageView('original');setDialog({type:'original',photo});}}/>
      <footer className="sv-footer"><FooterNote title={`本轮${summary?.total??0}件 · 不合格${summary?.fail??0}件`}/><Btn tone="primary" onClick={overview}>返回照片总览</Btn></footer>
    </>:<>
      <InspectionOverview realEnabled={hasRealRecognition(boot.recognition)} onRealTrial={()=>void run('正在添加模拟拍摄照片…',()=>update('real-trial'))} data={data} working={working} busy={!!busy} compact={density.compact} filter={filter} onFilter={value=>{scroll.current=0;setFilter(value);}} onToggleDensity={density.toggle} gallery={gallery} onScroll={top=>{scroll.current=top;}} actions={{open:openPhoto,add:picker,replace:p=>picker('album',p.id),remove:p=>setDialog({type:'remove',photo:p}),notes:()=>{setInstruction(round.instruction);setDialog({type:'notes'});},report:()=>navigate({task:route.task,view:'report'}),samples:()=>setDialog({type:'samples'})}}/>
        {pendingFiles.length?<div className="sv-upload-retry" role="status">还有{pendingFiles.length}张照片未确认保存。<Btn disabled={!!busy} onClick={()=>void run('正在重试上传…',()=>upload(pendingFiles))}>重试保存</Btn><Btn tone="quiet" disabled={!!busy} onClick={()=>setPendingFiles([])}>取消待上传照片</Btn></div>:null}
      <footer className="sv-footer sv-workflow-footer"><FooterNote title={round.status==='submitted'?'本轮结果已保存':working?`${round.photos.length}张照片已保存`:summary?.canSubmit?`${summary.verdict==='PASS'?'合格':'不合格'} · 不良数${summary.fail}`:summary?.qualityPhotos||summary?.failedPhotos?`${(summary?.qualityPhotos??0)+(summary?.failedPhotos??0)}张照片需要处理`:round.photos.length?'照片已保存，可继续添加':'正品基准已关联 · '+data.task.material}/>
        {round.status==='submitted'?<Btn disabled={!!busy} onClick={()=>setDialog({type:'retest'})}>重新检测</Btn>:round.photos.length?<><Btn disabled={locked} onClick={()=>picker('camera')}><Camera size={20}/>继续拍照</Btn><Btn tone="quiet" disabled={locked} onClick={()=>picker('album')}><ImagePlus size={20}/>从相册添加</Btn></>:null}
        {round.status==='submitted'?<Btn tone="primary" onClick={taskList}>返回任务列表</Btn>:summary?.canSubmit?<Btn tone="primary" disabled={!!busy||pendingFiles.length>0} onClick={()=>void run('正在发起回填…',async()=>{await update('submit');navigate({task:route.task,view:'transfer'});})}>提交到模拟MES</Btn>:summary?.qualityPhotos&&!summary.pendingPhotos&&!summary.failedPhotos?<Btn tone="primary" disabled={locked} onClick={()=>{scroll.current=0;setFilter('attention');}}>查看需重拍照片</Btn>:<Btn tone="primary" disabled={locked||!round.photos.length||pendingFiles.length>0} onClick={()=>void run('正在加入检测队列…',()=>update('analyze'))}>{working?<Spinner/>:null}{working?'正在检测':summary?.completed?'检测未完成部分':'开始检测'}</Btn>}
      </footer>
    </>}
    <input ref={album} tabIndex={-1} aria-hidden="true" className="sv-file-input" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e=>{filesPicked(e.target.files);e.target.value='';}}/><input ref={camera} tabIndex={-1} aria-hidden="true" className="sv-file-input" type="file" accept="image/*" capture="environment" onChange={e=>{filesPicked(e.target.files);e.target.value='';}}/>
    {dialog?.type==='samples'?<Modal title={dialog.replaceId?'用样例替换这张照片':'选择一种内置样例'} description="这些图片及检测结果为虚构预设，仅用于体验流程，不代表真实识别效果。" onClose={()=>{if(!busy)setDialog(null);}}><div className="sv-sample-options">{!dialog.replaceId?<Btn className="sv-sample-featured" disabled={!!busy} onClick={()=>void run('正在添加20张照片…',async()=>{await update('sample-set',{clientId:uploadKey()});setDialog(null);overview();})}><strong>20张照片 · 每张1件</strong><span>16件合格、4件不合格，试试紧凑预览</span></Btn>:null}{([['twenty','20个元件 · 同一张照片','16件合格、4件不合格，体验20个元件按钮'],['four','四个元件','3件合格、1件不合格，含建议复核'],['pass','一个合格元件','体验正常合格与增量检测'],['fail','一个不合格元件','体验字符错序与人工修正'],['quality','需要重拍的状态','体验质量提示及提交阻断']] as [SampleKind,string,string][]).map(([sample,title,sub])=><Btn key={sample} disabled={!!busy} onClick={()=>void run('正在添加样例…',async()=>{await update('sample',{sample,replaceId:dialog.replaceId});setDialog(null);overview();})}><strong>{title}</strong><span>{sub}</span></Btn>)}</div></Modal>:null}
    {dialog?.type==='remove'?<Modal title={'移除照片 '+photoName(dialog.photo)+'？'} description={`该照片及其${dialog.photo.components.length}件元件的结果会从本轮移除，已提交历史不受影响。`} onClose={()=>{if(!busy)setDialog(null);}} actions={<><Btn disabled={!!busy} onClick={()=>setDialog(null)}>保留照片</Btn><Btn tone="danger" disabled={!!busy} onClick={()=>void run('正在移除…',async()=>{await update('remove',{photoId:dialog.photo.id});setDialog(null);})}>确认移除</Btn></>}/>:null}
    {dialog?.type==='notes'?<Modal title="本次检测说明" description="补充此次任务的要求。保存后，已有元件也需要按最新说明重新判定，不必重拍。" onClose={()=>{if(!busy)setDialog(null);}} actions={<><Btn disabled={!!busy} onClick={()=>setDialog(null)}>取消</Btn><Btn tone="primary" disabled={!!busy} onClick={()=>void run('正在保存说明…',async()=>{await update('notes',{instruction});setDialog(null);setNotice('说明已保存，请点击检测，已有元件会按最新说明重新判定；内置预设样例仅演示流程。');})}>保存说明</Btn></>}><label className="sv-field">现场补充说明<textarea value={instruction} maxLength={4000} onChange={e=>setInstruction(e.target.value)} rows={5} placeholder="例如：本批次的日期码允许变化，重点核对型号。可用系统输入法语音输入。"/></label><p className="sv-description">本次说明随报告保留，优先于通用说明，不会修改正品数据库。</p></Modal>:null}
    {dialog?.type==='review'?<Modal title="修正元件结论" description="以人工核对后的结果为准，AI原判、修改人和原因会保留。" onClose={()=>{if(!busy)setDialog(null);}} actions={<><Btn disabled={!!busy} onClick={()=>setDialog(null)}>取消</Btn><Btn tone="primary" disabled={!!busy||!(reason+extraReason).trim()} onClick={()=>void run('正在保存修正…',async()=>{await update('review',{componentId:dialog.component.id,verdict,reason:[reason,extraReason].filter(Boolean).join('；')});setDialog(null);})}>保存修正</Btn></>}><fieldset className="sv-verdict-options"><legend>人工核对结论</legend>{(['PASS','FAIL'] as Verdict[]).map(v=><label key={v}><input type="radio" name="verdict" checked={verdict===v} onChange={()=>setVerdict(v)}/>{v==='PASS'?'合格':'不合格'}</label>)}</fieldset><label className="sv-field">修改原因<select value={reason} onChange={e=>setReason(e.target.value)}><option>AI识别错误，人工核对后修正</option><option>已核对实物，按现场标准修正</option><option>图片反光或模糊导致误判</option><option value="">其他原因（请补充）</option></select></label><label className="sv-field">补充说明（可选）<textarea value={extraReason} maxLength={800} onChange={e=>setExtraReason(e.target.value)} rows={3} placeholder="可使用系统输入法语音补充"/></label></Modal>:null}
    {dialog?.type==='retest'?<Modal title="开始新一轮检测" description="上次成功保存的结果仍然有效，新一轮成功回填后再替换。历史照片与人工记录不会删除。" onClose={()=>{if(!busy)setDialog(null);}} actions={<><Btn disabled={!!busy} onClick={()=>void run('正在准备新一轮…',async()=>{setData(await request<TaskView>('/tasks/'+data!.task.id+'/rounds',{reuse:false}));setDialog(null);overview();})}>重新拍摄</Btn><Btn tone="primary" disabled={!!busy} onClick={()=>void run('正在复用照片…',async()=>{setData(await request<TaskView>('/tasks/'+data!.task.id+'/rounds',{reuse:true}));setDialog(null);overview();})}>复用上一轮照片</Btn></>}/>:null}
    {dialog?.type==='original'?<Modal title={'照片 '+photoName(dialog.photo)} description={dialog.photo.message||'保留原始照片，可用浏览器或系统手势放大查看。'} onClose={()=>setDialog(null)} actions={<>{mutable(data)?<Btn disabled={!!busy} onClick={()=>{const id=dialog.photo.id;setDialog(null);setDialog({type:'samples',replaceId:id});}}>用样例替换</Btn>:null}<a className="sv-download" href={dialog.photo.url} target="_blank" rel="noreferrer">打开完整原图</a><Btn tone="primary" onClick={()=>setDialog(null)}>返回</Btn></>}>{dialog.photo.preparation?<div className="sv-extraction-tabs" role="group" aria-label="照片处理结果">{([['original','原始照片'],['annotated','定位与编号'],['sheet','裁片白板']] as const).map(([key,label])=><Btn key={key} tone="quiet" aria-pressed={imageView===key} onClick={()=>setImageView(key)}>{label}</Btn>)}</div>:null}<img className="sv-original-image" src={imageView==='annotated'&&dialog.photo.preparation?dialog.photo.preparation.annotatedUrl:imageView==='sheet'&&dialog.photo.preparation?dialog.photo.preparation.sheetUrl:dialog.photo.url} alt={imageView==='original'?dialog.photo.filename:imageView==='sheet'?'已转正的元件裁片白板':'元件位置与外侧编号引线'}/>{dialog.photo.preparation?<p className="sv-description">裁片来自原分辨率照片，不进行生成式补字。旋转仅做几何转正，文字方向仍由模型理解。</p>:null}{mutable(data)?<Btn disabled={!!busy} onClick={()=>{const id=dialog.photo.id;setDialog(null);picker('camera',id);}}>重新拍照并替换</Btn>:null}</Modal>:null}
  </div>;
}

function FooterNote({title}:{title:string}){return <div className="sv-footer-note"><strong>{title}</strong><span>只回填丝印检测项 · 检验单仍在MES最终确认</span></div>;}

import { useEffect, useRef, useState } from 'react';
import { FileSpreadsheet, Upload, Download, Check } from 'lucide-react';
import { Btn, Pill, Spinner } from '../ui';
import { request } from '../api';
import { Heading, Pagination } from './common';
import type { Navigate } from './index';
import type { Person } from '../../../shared/types';
import type { ImportJob } from '../../../shared/admin';
export function ImportView({person,navigate,onError,onSaved}:{person:Person;navigate:Navigate;onError:(e:unknown)=>void;onSaved:(s:string)=>void}){
  const storage='sv-admin-import:'+person.id,[job,setJob]=useState<ImportJob|null>(null),[files,setFiles]=useState<File[]>([]),[busy,setBusy]=useState(false),[filter,setFilter]=useState('all'),[page,setPage]=useState(1),[recovering,setRecovering]=useState(true);
  const manifest=useRef<HTMLInputElement>(null),images=useRef<HTMLInputElement>(null),pack=useRef<HTMLInputElement>(null);
  useEffect(()=>{const id=localStorage.getItem(storage);if(id)void request<ImportJob>('/admin/imports/'+id).then(setJob).catch(()=>localStorage.removeItem(storage)).finally(()=>setRecovering(false));else setRecovering(false);},[storage]);
  useEffect(()=>{if(job?.status!=='validating')return;let active=true;let timer:ReturnType<typeof setTimeout>;async function poll(){try{const v=await request<ImportJob>('/admin/imports/'+job!.id);if(active){setJob(v);timer=setTimeout(poll,1200);}}catch(e){if(active){onError(e);timer=setTimeout(poll,3000);}}}timer=setTimeout(poll,700);return()=>{active=false;clearTimeout(timer);};},[job?.id,job?.status]);
  function reset(){localStorage.removeItem(storage);setJob(null);setFiles([]);setPage(1);setFilter('all');}
  async function validate(){setBusy(true);try{const form=new FormData();for(const f of files)form.append('files',f);const v=await request<ImportJob>('/admin/imports',form);setJob(v);localStorage.setItem(storage,v.id);}catch(e){onError(e);}finally{setBusy(false);}}
  const rows=job?.rows.filter(r=>filter==='all'||r.status===filter)??[];
  return <><Heading title="批量导入正品标准" description="先检查清单与图片，确认后写入。已有标准默认跳过，不覆盖。"/>
    {!job?<><section className="adm-panel adm-import-guide"><div><FileSpreadsheet size={28}/><h2>1. 下载模板，整理资料</h2><p>Excel 适合人工整理；JSON 或完整 ZIP 适合已有资料转换。每批最多 2000 条，建议先用少量资料试导。</p></div><div className="adm-template-links"><a href="/api/admin/templates/xlsx" download><Download size={17}/>Excel 模板</a><a href="/api/admin/templates/json" download>JSON 模板</a><a href="/api/admin/templates/zip" download>含图片的 ZIP 示例</a><a href="/api/admin/templates/help" download>填写说明</a></div></section>
    <section className="adm-panel adm-import-guide"><h2>2. 选择清单与图片</h2><p>上传 Excel / JSON 清单后，再选择其中用到的图片。也可一次上传包含清单与图片的完整 ZIP。</p><div className="adm-import-choose"><Btn onClick={()=>manifest.current?.click()}><FileSpreadsheet size={18}/>选择清单</Btn><Btn onClick={()=>images.current?.click()}>添加图片</Btn><span>或</span><Btn onClick={()=>pack.current?.click()}><Upload size={18}/>上传完整 ZIP</Btn></div>
    <input hidden ref={manifest} type="file" accept=".xlsx,.json" onChange={e=>{const f=e.target.files?.[0];if(f)setFiles([f,...files.filter(x=>/\.(png|jpe?g|webp)$/i.test(x.name))]);e.target.value='';}}/>
    <input hidden ref={images} type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={e=>{if(e.target.files)setFiles([...files.filter(x=>/\.(xlsx|json)$/i.test(x.name)),...Array.from(e.target.files)]);e.target.value='';}}/>
    <input hidden ref={pack} type="file" accept=".zip" onChange={e=>{const f=e.target.files?.[0];if(f)setFiles([f]);e.target.value='';}}/>
    {files.length?<div className="adm-selected-files"><strong>已选择 {files.length} 个文件 · {(files.reduce((s,f)=>s+f.size,0)/1024/1024).toFixed(1)} MB</strong><p>{files.slice(0,5).map(f=>f.name).join('、')}{files.length>5?' 等':''}</p><Btn tone="quiet" onClick={()=>setFiles([])}>清除选择</Btn></div>:null}
    <p className="adm-footnote">单张图片最多 20MB，总大小最多 200MB。图片按清单路径或唯一文件名匹配；物料编号须使用文本格式，保留前导零。</p></section>
    <footer className="adm-form-footer"><span>预检不写入正品标准。</span><Btn onClick={()=>navigate('references')}>返回列表</Btn><Btn tone="primary" disabled={!files.length||busy||recovering} onClick={()=>void validate()}>{busy?<Spinner/>:null}{busy?'正在上传…':'开始预检'}</Btn></footer></>:
    job.status==='validating'?<section className="adm-panel adm-import-progress" role="status"><Spinner/><h2>正在预检清单与图片</h2><p>{job.message}</p><small>批量图片需要一些时间，可离开本页，回来后继续查看。</small></section>:
    job.status==='failed'?<section className="adm-panel adm-empty"><h2>预检未完成</h2><p>{job.message}</p><Btn tone="primary" onClick={reset}>重新选择文件</Btn></section>:
    job.status==='committed'?<section className="adm-panel adm-import-progress"><Check size={36}/><h2>导入完成</h2><p>{job.message}</p><div className="adm-actions"><Btn onClick={reset}>继续导入</Btn><Btn tone="primary" onClick={()=>navigate('references')}>查看正品标准</Btn></div></section>:
    <><section className="adm-panel adm-import-summary"><div><h2>预检结果</h2><p>{job.message}</p></div><Pill tone="success">可新增 {job.counts.ready}</Pill><Pill>重复跳过 {job.counts.skip}</Pill><Pill tone={job.counts.error?'danger':'neutral'}>需修正 {job.counts.error}</Pill></section>
    <div className="adm-import-filters" role="group" aria-label="预检结果筛选">{[['all','全部'],['ready','可新增'],['skip','重复项'],['error','需修正']].map(([value,label])=><Btn key={value} tone={filter===value?'primary':'quiet'} onClick={()=>{setFilter(value);setPage(1);}}>{label}</Btn>)}</div>
    <section className="adm-table-panel"><div className="adm-table-scroll"><table className="adm-table"><thead><tr><th>清单行</th><th>物料编号</th><th>供应商</th><th>预检状态</th><th>说明</th></tr></thead><tbody>{rows.slice((page-1)*25,page*25).map(r=><tr key={r.row}><td>{r.row}</td><td>{r.material||'—'}</td><td>{r.supplier||'—'}</td><td><Pill tone={r.status==='ready'?'success':r.status==='error'?'danger':'neutral'}>{r.status==='ready'?'可新增':r.status==='skip'?'跳过':'需修正'}</Pill></td><td>{r.message||r.imagePath}</td></tr>)}</tbody></table></div><Pagination total={rows.length} page={page} onPage={setPage}/></section>
    <footer className="adm-form-footer"><span>{job.counts.error?'有错误时不允许部分导入，请修正后重新上传。':'确认后一次写入，重复点击不会重复新增。'}</span><Btn disabled={busy} onClick={reset}>重新上传</Btn><Btn tone="primary" disabled={!!job.counts.error||!job.counts.ready||busy} onClick={()=>{setBusy(true);void request<ImportJob>('/admin/imports/'+job.id+'/commit',{}).then(v=>{setJob(v);onSaved(v.message);}).catch(onError).finally(()=>setBusy(false));}}>{busy?'正在导入…':`确认导入 ${job.counts.ready} 条`}</Btn></footer></>}
  </>;
}

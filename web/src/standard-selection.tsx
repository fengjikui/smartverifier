import { useEffect, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { request } from './api';
import { ZoomImage } from './image-viewer';
import { Btn, Field, Modal, Pill, Spinner } from './ui';
import type { CatalogChoice, CatalogPage } from '../../shared/catalog';
import type { TaskListItem } from '../../shared/types';

export function StandardSelection({onStart,onOpen,busy,onError}:{onStart:(standard:CatalogChoice)=>void;onOpen:(id:string)=>void;busy:boolean;onError:(error:unknown)=>void}) {
  const [material,setMaterial]=useState(''),[supplier,setSupplier]=useState(''),[page,setPage]=useState(1);
  const [data,setData]=useState<CatalogPage|null>(null),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0),[failed,setFailed]=useState(false);
  const [preview,setPreview]=useState<CatalogChoice|null>(null),[recent,setRecent]=useState<TaskListItem[]>([]),[historyOpen,setHistoryOpen]=useState(false);
  useEffect(()=>{
    let active=true;setLoading(true);setFailed(false);
    const timer=setTimeout(()=>void request<CatalogPage>(`/standards?material=${encodeURIComponent(material)}&supplier=${encodeURIComponent(supplier)}&page=${page}`)
      .then(value=>{if(active)setData(value);})
      .catch(error=>{if(active){setFailed(true);onError(error);}})
      .finally(()=>{if(active)setLoading(false);}),180);
    return()=>{active=false;clearTimeout(timer);};
  },[material,supplier,page,retry]);
  useEffect(()=>{if(!historyOpen)return;let active=true;void request<{items:TaskListItem[]}>('/checks').then(v=>{if(active)setRecent(v.items);}).catch(onError);return()=>{active=false;};},[historyOpen]);
  const blocked=busy||loading||failed;
  return <><main className="sv-main sv-standard-selection">
    <div className="sv-heading"><h1>选择正品，开始自主检测</h1><p>按物料编号或型号找到正品标准，再拍照检测。</p></div>
    <div className="sv-standard-filters"><label className="sv-field">物料编号 / 型号<div className="sv-standard-search"><Search size={19}/><Field value={material} placeholder="输入完整或部分物料编号、型号" onChange={e=>{setMaterial(e.target.value);setSupplier('');setPage(1);}}/></div></label>
      <label className="sv-field">供应商<select aria-label="供应商" value={supplier} onChange={e=>{setSupplier(e.target.value);setPage(1);}}><option value="">全部供应商</option>{(data?.suppliers??[]).map(name=><option key={name} value={name}>{name}</option>)}</select></label>
    </div>
    <p className="sv-standard-note">无需 MES 任务。检测完成后，在电脑 MES 中手工填写结论与不良数量。</p>
    <div className="sv-standard-results" aria-busy={loading}>
      {loading&&!data?<div className="sv-loading"><Spinner/>正在查询正品标准…</div>:failed?<div className="sv-standard-empty"><h2>暂时无法读取正品标准</h2><Btn onClick={()=>setRetry(v=>v+1)}>重新加载</Btn></div>:!data?.items.length?<div className="sv-standard-empty"><h2>{material||supplier?'没有找到匹配的正品标准':'暂无可用的正品标准'}</h2><p>{material||supplier?'可调整物料编号、型号或供应商，再试一次。':'请联系管理员录入正品图片并启用，检测说明可以留空。'}</p></div>:<div className={'sv-standard-grid'+(loading?' is-loading':'')}>{data.items.map(standard=><article className="sv-standard-choice" key={standard.id}>
        <button className="sv-standard-thumbnail" disabled={blocked} onClick={()=>setPreview(standard)} aria-label={'查看正品 '+standard.material+' '+(standard.modelNumber??'')}><img src={standard.thumbnail} alt="正品图片" loading="lazy"/></button>
        <div><h2>{standard.material}</h2><p>{standard.supplier||'供应商未填写'}</p>{standard.modelNumber||standard.name?<small>{standard.modelNumber||standard.name}</small>:null}</div>
        <Btn tone="primary" disabled={blocked} onClick={()=>onStart(standard)}>开始检测<ArrowRight size={17}/></Btn>
      </article>)}</div>}
    </div>
    <details className="sv-standalone-recent" onToggle={e=>setHistoryOpen(e.currentTarget.open)}><summary>最近的自主检测</summary><p className="sv-description">本系统保留最近 20 条入口，可继续草稿或查看结果。</p>{recent.length?<div>{recent.map(item=><article key={item.id}><div><strong>{item.material}</strong><p>{item.supplier} · {item.createdAt?new Date(item.createdAt).toLocaleString('zh-CN',{hour12:false}):''}</p></div><Pill tone={item.summary?.verdict==='FAIL'?'danger':item.summary?.verdict==='PASS'?'success':'neutral'}>{item.summary?.verdict?(item.summary.verdict==='PASS'?'合格':'不合格')+' · 不良数'+item.summary.fail:item.status}</Pill><Btn disabled={busy} onClick={()=>onOpen(item.id)}>{item.status==='已完成'?'查看结果':'继续检测'}</Btn></article>)}</div>:<p className="sv-description">还没有自主检测记录。</p>}</details>
  </main><footer className="sv-task-footer sv-selection-pagination"><span>共 {data?.total??0} 份可用标准</span><div><Btn aria-label="上一页标准" disabled={blocked||page<=1} onClick={()=>setPage(v=>v-1)}><ChevronLeft size={18}/></Btn><span>{page} / {Math.max(1,Math.ceil((data?.total??0)/25))}</span><Btn aria-label="下一页标准" disabled={blocked||page*25>=(data?.total??0)} onClick={()=>setPage(v=>v+1)}><ChevronRight size={18}/></Btn></div></footer>
  {preview?<Modal title="正品标准" description={preview.material+' · '+(preview.modelNumber??'')} onClose={()=>setPreview(null)} actions={<><Btn onClick={()=>setPreview(null)}>返回选择</Btn><Btn tone="primary" disabled={blocked} onClick={()=>{setPreview(null);onStart(preview);}}>使用此标准检测</Btn></>}><ZoomImage src={preview.image} alt="正品原图"/><div><h3>检测说明</h3><p className="sv-standard-description">{preview.description||'未补充特殊说明，按正品图片与通用规则比对。'}</p></div></Modal>:null}
  </>;
}

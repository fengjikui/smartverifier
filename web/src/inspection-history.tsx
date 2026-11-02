import { useEffect, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import type { TaskListItem } from '../../shared/types';
import { ApiError, request } from './api';
import { Btn, Field, Pill, Spinner } from './ui';

export function InspectionHistory({onOpen,onStart,busy,onError}:{onOpen:(id:string)=>void;onStart:()=>void;busy:boolean;onError:(error:unknown)=>void}){
  const [items,setItems]=useState<TaskListItem[]>([]),[query,setQuery]=useState('');
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true;setLoading(true);setError('');
    void request<{items:TaskListItem[]}>('/checks').then(data=>{if(active)setItems(data.items);}).catch(e=>{
      if(!active)return;setError(e instanceof ApiError?e.message:'暂时无法连接服务，请检查网络后重试。已保存的检测记录仍然保留。');
      if(e instanceof ApiError&&e.status===401)onError(e);
    }).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[revision]);
  const search=query.trim().toLocaleLowerCase();
  const visible=items.filter(item=>[item.material,item.modelNumber??'',item.supplier].some(value=>value.toLocaleLowerCase().includes(search)));
  return <><main className="sv-main sv-inspection-history">
    <div className="sv-history-heading"><div className="sv-heading"><h1>最近的自主检测</h1><p>继续未完成的检测，或查看已保存结果。</p></div><Btn tone="quiet" disabled={loading||busy} onClick={()=>setRevision(v=>v+1)}><RefreshCw size={17}/>刷新记录</Btn></div>
    <label className="sv-field">查询最近 20 条记录<div className="sv-standard-search"><Search size={19} aria-hidden="true"/><Field value={query} placeholder="物料编号 / 型号 / 供应商" onChange={e=>setQuery(e.target.value)}/></div></label>
    {loading?<div className="sv-loading" role="status"><Spinner/>正在读取检测记录…</div>:error?<section className="sv-standard-empty" role="alert"><h2>暂时无法读取检测记录</h2><p>{error}</p><Btn disabled={busy} onClick={()=>setRevision(v=>v+1)}>重新加载</Btn></section>:!items.length?<section className="sv-standard-empty"><h2>还没有自主检测记录</h2><p>选择一份正品标准开始检测，之后可在这里继续或查看结果。</p><Btn tone="primary" disabled={busy} onClick={onStart}>开始自主检测</Btn></section>:!visible.length?<section className="sv-standard-empty"><h2>最近记录中没有匹配项</h2><p>试试其他物料编号、型号或供应商关键词。</p><Btn onClick={()=>setQuery('')}>清空查询</Btn></section>:<section className="sv-panel sv-history-list" aria-label="最近自主检测记录">
      <div className="sv-history-table-head" aria-hidden="true"><span>物料编号 / 型号</span><span>检测状态</span><span>操作</span></div>
      {visible.map(item=><article className="sv-history-row" key={item.id} data-inspection-id={item.id}>
        <div className="sv-history-identity"><h2>{item.material}{item.modelNumber?<span> · {item.modelNumber}</span>:null}</h2><p><span>{item.supplier||'供应商未填写'}</span>{item.createdAt?<><span aria-hidden="true"> · </span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN',{hour12:false})}</time></>:null}</p></div>
        <div className="sv-history-status"><Pill tone={item.summary?.verdict==='FAIL'?'danger':item.summary?.verdict==='PASS'?'success':item.summary?.qualityPhotos||item.summary?.failedPhotos?'warning':'neutral'}>{item.summary?.verdict?(item.summary.verdict==='PASS'?'合格':'不合格')+' · 不良数 '+item.summary.fail:item.summary?.qualityPhotos?'需要重拍':item.summary?.failedPhotos?'识别未完成':item.status==='未提交'?'草稿':item.status}</Pill>{item.summary?.verdict?<small>{item.status==='已完成'?'已完成':'尚未完成本次检测'}</small>:null}</div>
        <Btn disabled={busy} aria-label={'打开检测记录 '+item.material+' '+(item.modelNumber??'')+' '+(item.createdAt??item.id)} onClick={()=>onOpen(item.id)}>{item.summary?.verdict?'查看结果':item.status==='检测中'?'查看进度':'继续检测'}</Btn>
      </article>)}
    </section>}
  </main><footer className="sv-task-footer sv-history-footer"><span>{loading?'正在读取…':error?'记录保留，稍后可重试':`显示 ${visible.length} 条记录`}</span><span>仅显示当前账号最近 20 条自主检测，按创建时间排列；不含 MES 任务。</span></footer></>;
}

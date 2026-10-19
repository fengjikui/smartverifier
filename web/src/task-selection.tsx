import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { Btn, Field, Pill, VerdictPill } from './ui';
import { request } from './api';
import type { TaskPage } from '../../shared/catalog';
export function TaskSelection({search,onSearch,onOpen,busy,onError}: {search:string;onSearch:(value:string)=>void;onOpen:(id:string)=>void;busy:boolean;onError:(e:unknown)=>void}) {
  const [data,setData]=useState<TaskPage|null>(null),[page,setPage]=useState(1),[loading,setLoading]=useState(true);
  useEffect(()=>{setPage(1);},[search]);
  useEffect(()=>{let active=true;setLoading(true);const timer=setTimeout(()=>void request<TaskPage>(`/tasks?q=${encodeURIComponent(search)}&page=${page}`).then(value=>{if(active)setData(value);}).catch(e=>{if(active)onError(e);}).finally(()=>{if(active)setLoading(false);}),180);return()=>{active=false;clearTimeout(timer);};},[search,page]);
  return <><main className="sv-main sv-tasks sv-task-selection">
    <div className="sv-task-heading"><div><h1>选择模拟 MES 任务</h1><p>已录入的正品标准可自动用于模拟任务，先验证完整检测流程。</p></div><label className="sv-task-search">搜索任务<div><Search size={19} aria-hidden="true"/><Field value={search} placeholder="单号末几位 / 物料 / 供应商" onChange={e=>onSearch(e.target.value)}/>{search?<Btn tone="quiet" className="sv-icon-button" aria-label="清空任务搜索" onClick={()=>onSearch('')}><X size={18}/></Btn>:null}</div></label></div>
    <section className="sv-panel sv-task-list" aria-busy={loading}><div className="sv-task-table-head"><span>检验任务 / 物料 / 供应商</span><span>当前状态</span><span>操作</span></div>
      {data?.items.map(task=><article className="sv-task-row" key={task.id}><div><h2>{task.number}</h2><p>{task.material} · {task.supplier}</p></div><div className="sv-task-status">{task.status==='已有结果'&&task.summary?.verdict?<VerdictPill verdict={task.summary.verdict}/>:<Pill tone={!task.standard?'warning':task.status==='检测中'?'warning':'neutral'}>{task.status}</Pill>}{task.status==='已有结果'?<small>已保存至模拟MES</small>:null}</div><Btn disabled={busy||loading} onClick={()=>onOpen(task.id)}>{!task.standard?'查看原因':task.status==='检测中'?'查看进度':task.status==='重检草稿'?'继续重检':task.effectiveRoundId?'查看结果':task.roundId?'继续检验':'开始检验'}</Btn></article>)}
      {!loading&&!data?.items.length?<div className="sv-task-no-match"><h2>没有找到对应任务</h2><p>试试物料编号或供应商关键词；管理员启用正品标准后，会出现对应模拟任务。</p><Btn tone="quiet" onClick={()=>onSearch('')}>清空搜索</Btn></div>:null}
    </section>
  </main><footer className="sv-task-footer sv-selection-pagination"><span>{loading?'正在查询…':`共${data?.total??0}项任务`}</span><div><Btn aria-label="上一页任务" disabled={busy||loading||page<=1} onClick={()=>setPage(v=>v-1)}><ChevronLeft size={18}/></Btn><span>{page} / {Math.max(1,Math.ceil((data?.total??0)/25))}</span><Btn aria-label="下一页任务" disabled={busy||loading||page*25>=(data?.total??0)} onClick={()=>setPage(v=>v+1)}><ChevronRight size={18}/></Btn></div><details><summary>模拟说明</summary><p>当前未连接公司 MES。模拟任务不是真实检验单；只有点击开始检测后才保存检测草稿，身份和回填也为模拟。</p></details></footer></>;
}

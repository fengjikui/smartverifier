import { Search, X } from 'lucide-react';
import type { TaskListItem } from '../../shared/types';
import { Btn, Field, Pill, VerdictPill } from './ui';

export function TaskSelection({tasks,search,onSearch,onOpen,busy}: {tasks:TaskListItem[];search:string;onSearch:(value:string)=>void;onOpen:(id:string)=>void;busy:boolean}) {
  const matches=tasks.filter(t=>[t.number,t.material,t.supplier].some(x=>x.toLowerCase().includes(search.trim().toLowerCase())));
  return <><main className="sv-main sv-tasks sv-task-selection">
    <div className="sv-task-heading"><div><h1>选择检验任务</h1><p>找到本次来料，开始或继续检验。</p></div><label className="sv-task-search">搜索任务<div><Search size={19} aria-hidden="true"/><Field value={search} placeholder="单号末几位 / 物料 / 供应商" onChange={e=>onSearch(e.target.value)}/>{search?<Btn tone="quiet" className="sv-icon-button" aria-label="清空任务搜索" onClick={()=>onSearch('')}><X size={18}/></Btn>:null}</div></label></div>
    <section className="sv-panel sv-task-list"><div className="sv-task-table-head"><span>检验任务 / 物料 / 供应商</span><span>当前状态</span><span>操作</span></div>
      {matches.map(t=><article className="sv-task-row" key={t.id}><div><h2>{t.number}</h2><p>{t.material} · {t.supplier}</p></div><div className="sv-task-status">{t.status==='已有结果'&&t.summary?.verdict?<VerdictPill verdict={t.summary.verdict}/>:<Pill tone={!t.standard?'warning':t.status==='检测中'?'warning':'neutral'}>{t.status}</Pill>}{t.status==='已有结果'?<small>已保存</small>:null}</div><Btn disabled={busy} onClick={()=>onOpen(t.id)}>{!t.standard?'查看原因':t.status==='检测中'?'查看进度':t.status==='重检草稿'?'继续重检':t.effectiveRoundId?'查看结果':t.roundId?'继续检验':'开始检验'}</Btn></article>)}
      {!matches.length?<div className="sv-task-no-match"><h2>没有找到对应任务</h2><p>试试单号末几位，或换一个物料、供应商关键词。</p><Btn tone="quiet" onClick={()=>onSearch('')}>清空搜索</Btn></div>:null}
    </section>
  </main><footer className="sv-task-footer"><span aria-live="polite">{search?`找到${matches.length}项，共${tasks.length}项任务`:`共${tasks.length}项任务`}</span><details><summary>本地试用说明</summary><p>任务、身份和 MES 均为模拟，未连接公司系统。照片草稿与检测记录由本机服务保存。</p></details></footer></>;
}

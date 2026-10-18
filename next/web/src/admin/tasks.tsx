import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Search } from 'lucide-react';
import { Btn, Field, Pill } from '../ui';
import { request } from '../api';
import { Empty, Heading, Loading, Pagination } from './common';
import type { TaskPage } from '../../../shared/catalog';
import type { TaskListItem } from '../../../shared/types';

export function TaskList({onError,revision}:{onError:(e:unknown)=>void;revision:number}) {
  const [tasks,setTasks]=useState<TaskPage|null>(null);
  const [query,setQuery]=useState('');
  const [page,setPage]=useState(1);
  const [refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    let active=true;
    setLoading(true);
    const timer=setTimeout(()=>void request<TaskPage>(`/admin/tasks?q=${encodeURIComponent(query)}&page=${page}`)
      .then(value=>{if(active)setTasks(value);})
      .catch(error=>{if(active)onError(error);})
      .finally(()=>{if(active)setLoading(false);}),180);
    return()=>{active=false;clearTimeout(timer);};
  },[revision,refresh,query,page]);

  const keyword=query.trim(),filtered=tasks?.items??[];

  return <>
    <Heading title="检验任务" description="查看 MES 下发的任务及其正品标准关联情况。">
      <Btn disabled={loading} onClick={()=>setRefresh(value=>value+1)}>
        <RefreshCw size={17}/>{loading?'正在刷新…':'刷新列表'}
      </Btn>
    </Heading>
    <div className="adm-notice adm-neutral">
      任务由 MES 同步，本系统仅展示与选择。当前 MES 接口尚未接通，已启用的正品标准可自动用于模拟任务。
    </div>
    <div className="adm-toolbar">
      <label className="adm-search">关键词查询<div>
        <Search size={18}/>
        <Field placeholder="搜索任务单号 / 物料编号 / 供应商" value={query}
          onChange={event=>{setQuery(event.target.value);setPage(1);}}/>
      </div></label>
    </div>
    <section className="adm-table-panel" aria-busy={loading}>
      {!tasks?<Loading/>:!filtered.length?<Empty
        title={keyword?'没有找到匹配的任务':'暂无检验任务'}
        description={keyword?'试试任务单号的一部分，或物料编号、供应商名称。':'任务将由 MES 提供，无需在这里手工录入。'}
      />:<div className="adm-table-scroll"><table className="adm-table">
        <thead><tr><th>任务单号</th><th>物料编号 / 供应商</th><th>正品标准</th><th>检测状态</th><th>操作</th></tr></thead>
        <tbody>{filtered.map(task=><tr key={task.id}>
          <td><strong>{task.number}</strong><small>{task.origin==='mes'?'MES 任务':task.origin==='demo-mes'?'模拟MES任务':task.origin==='local'?'历史试用任务':'内置演示任务'}</small></td>
          <td>{task.material}<small>{task.supplier}</small></td>
          <td>{task.standard?<Pill tone="success">已关联 · v{task.standard.version}</Pill>:<Pill tone="warning">缺少基准</Pill>}</td>
          <td>{task.status}</td>
          <td><a className="adm-open-task" href={'/?task='+task.id} target="_blank" rel="noreferrer">
            打开检验 <ExternalLink size={15}/>
          </a></td>
        </tr>)}</tbody>
      </table></div>}
      <Pagination page={page} total={tasks?.total??0} onPage={setPage}/>
    </section>
  </>;
}

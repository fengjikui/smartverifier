import { analysisIssues } from '../../../shared/reference-analysis';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import { Btn, Pill, Spinner } from '../ui';
import type { ReferenceRecord } from '../../../shared/admin';
export const date=(s:string)=>new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(s));
export function ReferenceStatus({record:r}:{record:ReferenceRecord}){const waiting=r.analysis&&['queued','running'].includes(r.analysis.state),label=r.deletedAt?'已移入回收站':r.status==='active'?'已启用':r.needsRemark?'需重新标记':waiting?'分析中':r.analysis?.state==='failed'?'分析失败':analysisIssues(r.analysis).length?'待确认':'草稿';return <Pill tone={r.deletedAt?'neutral':r.status==='active'?'success':waiting?'neutral':'warning'}>{waiting?<Spinner/>:null}{label}</Pill>;}

export function Thumb({record}:{record:ReferenceRecord}){return <div className="adm-thumb">{record.asset?<img src={record.asset.thumbnail} loading="lazy" width="64" height="64" alt=""/>:<ImageOff size={22}/>}</div>;}
export function Heading({title,description,children}:{title:string;description:string;children?:ReactNode}){return <div className="adm-heading"><div><h1>{title}</h1><p>{description}</p></div><div className="adm-actions">{children}</div></div>;}
export function Pagination({page,total,size=25,onPage}:{page:number;total:number;size?:number;onPage:(page:number)=>void}){return <div className="adm-pagination"><span>共 {total.toLocaleString()} 条{total>0?` · 第 ${(page-1)*size+1}–${Math.min(page*size,total)} 条`:''}</span><div className="adm-actions"><Btn aria-label="上一页" className="adm-icon" disabled={page<=1} onClick={()=>onPage(page-1)}><ChevronLeft size={18}/></Btn><span>{page} / {Math.max(1,Math.ceil(total/size))}</span><Btn aria-label="下一页" className="adm-icon" disabled={page*size>=total} onClick={()=>onPage(page+1)}><ChevronRight size={18}/></Btn></div></div>;}
export function Empty({title,description,children}:{title:string;description:string;children?:ReactNode}){return <div className="adm-empty"><ImageOff size={32}/><h2>{title}</h2><p>{description}</p>{children}</div>;}
export function Loading(){return <div className="adm-loading" role="status"><Spinner/>正在读取…</div>;}
export const actionName=(a:string)=>({'reference.create':'新增标准','reference.update':'修改标准','reference.delete':'移入回收站','reference.restore':'恢复标准','task.create':'创建任务','task.update':'修改任务','task.delete':'删除未开始任务','import.commit':'批量导入'}[a]??a);

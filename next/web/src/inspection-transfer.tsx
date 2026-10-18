import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Person, TaskView } from '../../shared/types';
import { Spinner, VerdictPill } from './ui';

export function InspectionTransfer({data,person}: {data:TaskView;person:Person}) {
  const round=data.round!,summary=data.summary!,sending=round.status==='submitting',success=round.transfer?.status==='success';
  return <main className="sv-main sv-transfer"><section className="sv-transfer-content">
    <div className="sv-transfer-status">{sending?<Spinner/>:success?<CheckCircle2 size={44} className="sv-success-icon"/>:<AlertTriangle size={44} className="sv-warning-icon"/>}<h1>{sending?'正在保存到模拟MES':success?'已保存到模拟MES':'结果尚未保存到MES'}</h1></div>
    <p className="sv-transfer-task">检验单号 {data.task.number}</p>
    <div className="sv-transfer-conclusion"><VerdictPill verdict={summary.verdict}/><span>已检测 {summary.total}件</span><span>不良数 {summary.fail}</span></div>
    {sending?<p className="sv-transfer-message" role="status">正在确认保存，照片和检测结果已保留。</p>:success?<p className="sv-transfer-message">丝印检测项已保存，可以继续处理下一项任务。</p>:<div className="sv-transfer-failure" role="alert"><p>{round.transfer?.message??'未确认保存成功，检测结果已保留，请重试。'}</p><p>{data.effective?'上次成功保存的结果仍然有效。':'本任务尚无成功保存的结果。'}</p></div>}
    {success?<details className="sv-transfer-receipt"><summary>查看保存凭证</summary><dl><dt>保存回执</dt><dd>{round.transfer?.receipt}</dd><dt>操作人员</dt><dd>{round.submittedBy?.name??person.name} · {round.submittedBy?.id??person.id}</dd><dt>保存时间</dt><dd>{round.transfer?.at?new Date(round.transfer.at).toLocaleString('zh-CN'):''}</dd></dl></details>:null}
    <p className="sv-transfer-note">当前为本地模拟，未连接公司MES；整张检验单仍由人员在MES最终确认。</p>
  </section></main>;
}

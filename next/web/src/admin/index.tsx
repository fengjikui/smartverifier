import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, LogOut, Plus } from 'lucide-react';
import { Btn, Field, Pill, Spinner } from '../ui';
import { request, ApiError } from '../api';
import { ReferenceList, ReferenceDetailView, AuditView } from './references';
import { ReferenceForm } from './reference-form';
import { TaskList } from './tasks';
import { ImportView } from './import-view';
import type { AdminSession } from '../../../shared/admin';
import './style.css';
export type Navigate=(to:string)=>void;
const route=()=>location.pathname.replace(/^\/admin\/?/,'')||'references';
export function Admin(){
  const [session,setSession]=useState<AdminSession|null>(null),[loading,setLoading]=useState(true),[path,setPath]=useState(route),[notice,setNotice]=useState(''),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  const dirty=useRef(false);
  useEffect(()=>{document.title='观微 · 正品管理工作台';void request<AdminSession>('/admin/session').then(setSession).catch(e=>{if(!(e instanceof ApiError&&e.status===401))setError(e.message);}).finally(()=>setLoading(false));const back=()=>{if(dirty.current&&!confirm('当前修改尚未保存，确定离开吗？')){history.forward();return;}dirty.current=false;setPath(route());};window.addEventListener('popstate',back);return()=>window.removeEventListener('popstate',back);},[]);
  useEffect(()=>{const handler=(e:BeforeUnloadEvent)=>{if(dirty.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[]);
  function go(to:string){if(dirty.current&&!confirm('当前修改尚未保存，确定离开吗？'))return;dirty.current=false;history.pushState(null,'','/admin/'+to);setPath(to);setError('');}
  function failed(e:unknown){const err=e as Error;setError(err.message);if(e instanceof ApiError&&e.status===401)setSession(null);}
  function saved(message:string,to?:string){dirty.current=false;setNotice(message);setRevision(v=>v+1);if(to)go(to);}
  if(loading)return <div className="adm-loading"><Spinner/>正在打开正品管理工作台…</div>;
  if(!session)return <AdminLogin error={error} onLogin={setSession} onError={failed}/>;
  const kind=path.split('/')[0],id=path.split('/')[1],isForm=kind==='new'||kind==='edit'||kind==='copy';
  const nav=[['references','grid','正品标准'],['tasks','grid','检验任务'],['audit','clock','维护日志'],['trash','trash','回收站']];
  return <div className="adm-app">
    <aside className="adm-sidebar"><div className="adm-brand"><img src="/assets/admin/scan.svg" width="30" height="30" alt=""/><strong>观微</strong></div><p>正品管理工作台</p><nav aria-label="管理导航">{nav.map(([key,icon,label])=><button key={key} aria-current={kind===key||(key==='trash'&&path.endsWith('/trash'))||(key==='references'&&!path.endsWith('/trash')&&['new','edit','copy','detail','import'].includes(kind))?'page':undefined} onClick={()=>go(key)}><img src={'/assets/admin/'+icon+'.svg'} width="22" height="22" alt=""/>{label}</button>)}</nav><div className="adm-person"><strong>{session.person.name}</strong><span>{session.person.id} · 管理员试用</span><Btn tone="quiet" onClick={()=>{if(dirty.current&&!confirm('尚有未保存的修改，仍要退出吗？'))return;void request('/admin/session',{},'DELETE').then(()=>{dirty.current=false;setSession(null);}).catch(failed);}}><LogOut size={16}/>退出</Btn></div></aside>
    <div className="adm-workspace"><header className="adm-topbar"><div>{isForm||kind==='detail'||kind==='import'?<Btn tone="quiet" aria-label="返回正品标准" onClick={()=>go(kind==='detail'&&path.endsWith('/trash')?'trash':'references')}><ArrowLeft size={18}/></Btn>:null}<span>正品管理 / {kind==='tasks'?'检验任务':kind==='audit'?'维护日志':kind==='trash'?'回收站':'正品标准'}</span></div><Pill>{session.localOnly?'仅本机试用':'临时授权录入'}</Pill></header>
    <main className="adm-main" key={path}>
      {notice?<div className="adm-notice" role="status">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}>×</button></div>:null}
      {error?<div className="adm-error" role="alert">{error}<button aria-label="关闭错误提示" onClick={()=>setError('')}>×</button></div>:null}
      {isForm?<ReferenceForm mode={kind} id={id} person={session.person} onDirty={v=>dirty.current=v} onSaved={saved} onError={failed} navigate={go}/>:
      kind==='detail'?<ReferenceDetailView id={id} navigate={go} onError={failed} onSaved={saved}/>:
      kind==='import'?<ImportView person={session.person} navigate={go} onError={failed} onSaved={saved}/>:
      kind==='tasks'?<TaskList onError={failed} revision={revision}/>:
      kind==='audit'?<AuditView onError={failed}/>:
      <ReferenceList trash={kind==='trash'} navigate={go} onError={failed} onSaved={saved} revision={revision}/>}
    </main></div>
  </div>;
}
function AdminLogin({error,onLogin,onError}:{error:string;onLogin:(v:AdminSession)=>void;onError:(e:unknown)=>void}){
  const [id,setId]=useState('admin'),[name,setName]=useState('本机管理员'),[code,setCode]=useState('admin123'),[mode,setMode]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{void request<{accessMode:string}>('/admin/config').then(v=>setMode(v.accessMode)).catch(onError);},[]);
  return <div className="adm-login"><div className="adm-brand"><img src="/assets/admin/scan.svg" width="30" height="30" alt=""/><strong>观微</strong><span>正品管理工作台</span></div><form onSubmit={e=>{e.preventDefault();setBusy(true);void request<AdminSession>('/admin/session',{id,code}).then(onLogin).catch(onError).finally(()=>setBusy(false));}}><h1>管理每一份检测依据</h1><p>录入正品图片与检查说明，检验任务自动关联。</p><Pill tone="warning">{mode==='access-code'?'临时管理员授权':'本机录入试用 · 未接入 IDaaS'}</Pill><label>账号<Field required maxLength={80} value={id} onChange={e=>setId(e.target.value)}/></label><label>密码<Field required type="password" autoComplete="current-password" value={code} onChange={e=>setCode(e.target.value)}/></label>{mode!=='access-code'?<p className="adm-trial-account">试用账号：admin　密码：admin123</p>:null}{error?<p className="adm-error" role="alert">{error}</p>:null}<Btn tone="primary" disabled={busy||!mode}>{busy?<Spinner/>:null}进入正品管理</Btn><small>{mode==='access-code'?'公司统一登录后续接入；当前操作按临时授权人员记录。':'当前仅限服务器本机试用，日志记录为试用管理员；公司 IDaaS 身份认证待接入。'}</small></form></div>;
}

import { adminPath, adminRoute, assetPath } from '../../../shared/paths';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, LogOut, Plus } from 'lucide-react';
import { Btn, Field, Pill, Spinner } from '../ui';
import { request, ApiError } from '../api';
import { ReferenceList, ReferenceDetailView, AuditView } from './references';
import { ReferenceForm } from './reference-form';
import { TaskList } from './tasks';
import { ImportView } from './import-view';
import type { AdminSession, AdminLoginConfig } from '../../../shared/admin';
import './style.css';
export type Navigate=(to:string)=>void;
const route=()=>adminRoute(location.pathname,location.search);
export function Admin(){
  const [session,setSession]=useState<AdminSession|null>(null),[loading,setLoading]=useState(true),[path,setPath]=useState(route),[notice,setNotice]=useState(''),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  const dirty=useRef(false);
  useEffect(()=>{document.title='鉴微 · 正品管理工作台';void request<AdminSession>('/admin/session').then(setSession).catch(e=>{if(!(e instanceof ApiError&&e.status===401))setError(e.message);}).finally(()=>setLoading(false));const back=()=>{if(dirty.current&&!confirm('当前修改尚未保存，确定离开吗？')){history.forward();return;}dirty.current=false;setPath(route());};window.addEventListener('popstate',back);return()=>window.removeEventListener('popstate',back);},[]);
  useEffect(()=>{const handler=(e:BeforeUnloadEvent)=>{if(dirty.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[]);
  function go(to:string){if(dirty.current&&!confirm('当前修改尚未保存，确定离开吗？'))return;dirty.current=false;history.pushState(null,'',adminPath(to));setPath(to);setError('');}
  function failed(e:unknown){const err=e as Error;setError(err.message);if(e instanceof ApiError&&e.status===401)setSession(null);}
  function saved(message:string,to?:string){dirty.current=false;setNotice(message);setRevision(v=>v+1);if(to)go(to);}
  if(loading)return <div className="adm-loading"><Spinner/>正在打开正品管理工作台…</div>;
  if(!session)return <AdminLogin error={error} onLogin={value=>{setError('');setSession(value);}} onError={failed}/>;
  const kind=path.split('/')[0],id=path.split('/')[1],isForm=kind==='new'||kind==='edit'||kind==='copy';
  const nav=[['references','grid','正品标准'],['tasks','grid','检验任务'],['audit','clock','维护日志'],['trash','trash','回收站']];
  return <div className="adm-app">
    <aside className="adm-sidebar"><div className="adm-brand"><img src={assetPath('admin/scan.svg')} width="30" height="30" alt=""/><strong>鉴微</strong></div><p>正品管理工作台</p><nav aria-label="管理导航">{nav.map(([key,icon,label])=><button key={key} aria-current={kind===key||(key==='trash'&&path.endsWith('/trash'))||(key==='references'&&!path.endsWith('/trash')&&['new','edit','copy','detail','import'].includes(kind))?'page':undefined} onClick={()=>go(key)}><img src={assetPath('admin/'+icon+'.svg')} width="22" height="22" alt=""/>{label}</button>)}</nav><div className="adm-person"><strong>{session.person.name}</strong><span>{session.person.id} · {session.mode==='password'?'正品管理员':'管理员试用'}</span><Btn tone="quiet" onClick={()=>{if(dirty.current&&!confirm('尚有未保存的修改，仍要退出吗？'))return;void request('/admin/session',{},'DELETE').then(()=>{dirty.current=false;setSession(null);}).catch(failed);}}><LogOut size={16}/>退出</Btn></div></aside>
    <div className="adm-workspace"><header className="adm-topbar"><div>{isForm||kind==='detail'||kind==='import'?<Btn tone="quiet" aria-label="返回正品标准" onClick={()=>go(kind==='detail'&&path.endsWith('/trash')?'trash':'references')}><ArrowLeft size={18}/></Btn>:null}<span>正品管理 / {kind==='tasks'?'检验任务':kind==='audit'?'维护日志':kind==='trash'?'回收站':'正品标准'}</span></div><Pill>{session.localOnly?'本机会话':'协作录入'}</Pill></header>
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
  const [id,setId]=useState(''),[code,setCode]=useState(''),[config,setConfig]=useState<AdminLoginConfig|null>(null),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;void request<AdminLoginConfig>('/admin/config').then(v=>{if(!active)return;setConfig(v);if(v.accessMode==='trial'){setId('admin');setCode('admin123');}}).catch(onError);return()=>{active=false;};},[]);
  return <div className="adm-login"><div className="adm-brand"><img src={assetPath('admin/scan.svg')} width="30" height="30" alt=""/><strong>鉴微</strong><span>正品管理工作台</span></div><form onSubmit={e=>{e.preventDefault();if(!config||busy)return;setBusy(true);void request<AdminSession>('/admin/session',{id,code}).then(onLogin).catch(onError).finally(()=>setBusy(false));}}><h1>管理每一份检测依据</h1><p>录入正品图片与检查说明，检验任务自动关联。</p>
    {config?<Pill tone={config.accessMode==='trial'?'warning':'neutral'}>{config.accessMode==='trial'?'本机开发试用':config.localOnly?'账号密码登录 · 仅本机':'账号密码登录 · 协作录入'}</Pill>:<p role="status">正在读取登录设置…</p>}
    <label>账号<Field required maxLength={80} autoComplete="username" value={id} onChange={e=>setId(e.target.value)}/></label><label>密码<Field required maxLength={256} type="password" autoComplete="current-password" value={code} onChange={e=>setCode(e.target.value)}/></label>
    {config?.accessMode==='trial'?<p className="adm-trial-account">试用账号：admin　密码：admin123</p>:null}{error?<p className="adm-error" role="alert">{error}</p>:null}<Btn tone="primary" disabled={busy||!config}>{busy?<Spinner/>:null}进入正品管理</Btn>
    <small>{config?.accessMode==='password'?'使用部署人员分配的管理员账号和密码；维护记录会保留你的账号与姓名。':'默认试用账号仅限服务器本机。协作录入前，请由部署人员设置管理员账号并开放访问。'}</small></form></div>;
}

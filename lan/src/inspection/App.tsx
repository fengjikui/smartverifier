import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Check, LoaderCircle, LogOut, ScanLine, Settings2, UserRound, X } from 'lucide-react';
import { ApiError, requestId } from '../api';
import { request, type Bootstrap, type Task } from './api';
import { Access, type TrialUser } from './Access';
import { TaskForm } from './Forms';
import { TaskList } from './TaskList';
import { TaskScreen } from './TaskScreen';
import { CaptureCamera } from './Camera';
import './style.css';

type PendingUpload = { file: File; requestId: string; replaceId: string; taskId: string };
export default function InspectionApp() { return <Access>{(user, logout) => <Workspace key={user.account} user={user} logout={logout} />}</Access>; }
function Workspace({ user, logout }: { user: TrialUser; logout: () => Promise<void> }) {
  const savedKey = 'sv-inspection-task:' + user.account;
  const [boot, setBoot] = useState<Bootstrap | null>(null), [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('');
  const [showNew, setShowNew] = useState(false), [settings, setSettings] = useState(false), [version, setVersion] = useState(0);
  const [model, setModel] = useState(''), [cameraOpen, setCameraOpen] = useState(false), [expired, setExpired] = useState(false), [renewPassword, setRenewPassword] = useState('');
  const [pending, setPending] = useState<PendingUpload[]>([]), [discard, setDiscard] = useState(false), [replaceId, setReplaceId] = useState('');
  const initialized = useRef(false), busyRef = useRef(false), selectedId = useRef<string | null>(null), replacement = useRef('');
  const album = useRef<HTMLInputElement>(null), systemCamera = useRef<HTMLInputElement>(null);
  function report(e: unknown) { setError((e as Error).message || '操作没有完成，请重试。'); if (e instanceof ApiError && [401, 403].includes(e.status)) setExpired(true); }
  function select(t: Task | null) {
    selectedId.current = t?.id || null; setTask(t); setError(''); setNotice(''); setShowNew(false);
    if (t) localStorage.setItem(savedKey, t.id); else localStorage.removeItem(savedKey);
    window.scrollTo({ top: 0 });
  }
  async function refresh() {
    const data = await request<Bootstrap>('/bootstrap'); setBoot(data); setVersion(v => v + 1);
    setModel(old => data.models.some(m => m.id === old && m.available) ? old : data.models.find(m => m.available && m.id === 'hr-qwen')?.id || data.models.find(m => m.available && /27b/i.test(m.id))?.id || data.models.find(m => m.available)?.id || '');
    return data;
  }
  async function initialize() {
    setLoading(true); setError('');
    try { await refresh(); const previous = localStorage.getItem(savedKey) || localStorage.getItem('sv-inspection-task');
      if (previous) { try { select(await request<Task>('/tasks/' + previous)); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; localStorage.removeItem(savedKey); } }
      localStorage.removeItem('sv-inspection-task');
    } catch (e) { report(e); } finally { setLoading(false); }
  }
  const onMount = useEffectEvent(initialize);
  useEffect(() => { if (initialized.current) return; initialized.current = true; void onMount(); }, []);
  const working = !!task && (['queued', 'running'].includes(task.run.status) || task.transfer?.status === 'sending'), taskId = task?.id;
  useEffect(() => {
    if (!working || !taskId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try { const t = await request<Task>('/tasks/' + taskId); if (!cancelled && selectedId.current === taskId) { setTask(t); setError(''); } }
      catch (e) { if (!cancelled) report(e); }
      if (!cancelled) timer = setTimeout(tick, 2200);
    }
    timer = setTimeout(tick, 1000); return () => { cancelled = true; clearTimeout(timer); };
  }, [working, taskId]);
  useEffect(() => {
    if (!pending.length) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [pending.length]);
  async function act(label: string, fn: () => Promise<void>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(label); setError(''); setNotice('');
    try { await fn(); return true; } catch (e) { report(e); return false; } finally { busyRef.current = false; setBusy(''); }
  }
  async function mutate(suffix: string, data: object = {}) {
    if (!task) return;
    const t = await request<Task>(`/tasks/${task.id}${suffix}`, data); setTask(t);
  }
  async function uploadItems(items: PendingUpload[]) {
    let remaining = [...items]; setPending(remaining); setDiscard(false);
    for (const item of items) {
      setBusy(`正在保存 ${item.file.name}…`);
      const form = new FormData(); form.append('file', item.file); form.append('request_id', item.requestId); form.append('replace_id', item.replaceId);
      try { const t = await request<Task>(`/tasks/${item.taskId}/photos`, form); if (selectedId.current === t.id) setTask(t); }
      catch (e) { if (e instanceof ApiError && e.status === 409 && e.message.includes('不会重复计数')) { remaining = remaining.slice(1); setPending(remaining); setNotice(e.message); continue; } throw e; }
      remaining = remaining.slice(1); setPending(remaining);
    }
    setReplaceId(''); replacement.current = ''; setNotice('照片已保存，自动裁剪已完成。');
  }
  async function upload(files: File[], replace = replacement.current) {
    if (!task || !files.length) return;
    if (pending.length) throw new Error('请先处理尚未保存的照片。');
    await uploadItems((replace ? files.slice(0, 1) : files).map(file => ({ file, requestId: requestId(), replaceId: replace, taskId: task.id })));
  }
  function picker(files: FileList | null) { const chosen = Array.from(files || []); if (chosen.length) void act('正在保存照片…', () => upload(chosen)); }
  function setReplacement(id = '') { replacement.current = id; setReplaceId(id); }
  function openCamera(id = '') {
    setReplacement(id);
    if (window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function') setCameraOpen(true);
    else systemCamera.current?.click();
  }
  function openAlbum(id = '') { setReplacement(id); if (album.current) { album.current.multiple = !id; album.current.click(); } }
  const back = () => void act('正在打开任务列表…', async () => { await refresh(); select(null); });
  const uploadNotice = pending.length > 0 && <div className="iw-alert iw-warning" role="status"><div><strong>{pending.length} 张照片尚未确认保存</strong><p>{busy || '请保留本页，网络恢复后重试。'}</p></div>{!busy && <div className="iw-actions"><button onClick={() => void act('正在重试…', () => uploadItems(pending))}>重试保存</button>{discard ? <><button onClick={() => { setPending([]); setReplacement(); setDiscard(false); }}>确认放弃这 {pending.length} 张</button><button onClick={() => setDiscard(false)}>保留照片</button></> : <button onClick={() => setDiscard(true)}>放弃未保存照片</button>}</div>}</div>;
  if (loading || !boot) return <main className="iw"><div className="iw-connection"><ScanLine size={32} /><h1>{loading ? '正在打开工作台' : '暂时无法连接'}</h1><p role="status">{error}</p>{!loading && <div className="iw-actions"><button onClick={() => void initialize()}>重试</button><button onClick={() => void logout()}>返回登录</button></div>}</div></main>;
  return <main className="iw"><header className="iw-header" inert={cameraOpen}><a href="/" className="iw-brand" onClick={e => { e.preventDefault(); if (!busy && !pending.length) back(); }}><span className="iw-brand-mark"><ScanLine size={26} /></span><strong>观微</strong><span className="iw-brand-description">丝印检验</span></a><div className="iw-header-actions"><span className="iw-environment">{boot.mes_mode === 'mock' ? '本地试用 · 模拟 MES' : 'MES 接口联调'}</span><span className="iw-user"><UserRound size={18} />{user.name}</span><button className="iw-icon-label" title="退出登录" disabled={!!busy || pending.length > 0} onClick={() => void act('正在退出…', logout)}><LogOut size={18} /><span>退出</span></button></div></header>
    <div className="iw-shell" inert={cameraOpen}>{error && <div className="iw-alert iw-error" role="alert"><span>{error}</span>{expired ? null : <button aria-label="关闭提示" onClick={() => setError('')}><X size={18} /></button>}</div>}{expired && <form className="iw-form-panel" onSubmit={e => { e.preventDefault(); void act('正在恢复登录…', async () => { await request('/auth/login', { account: user.account, password: renewPassword }); setExpired(false); setRenewPassword(''); setNotice('登录已恢复，可以继续保存照片。'); }); }}><h2>恢复登录，继续当前检验</h2><p>当前账号 {user.account}。未保存照片仍保留在本页。</p><label>试用账号密码<input type="password" autoComplete="current-password" minLength={8} required value={renewPassword} onChange={e => setRenewPassword(e.target.value)} /></label><div className="iw-actions"><button className="iw-primary" disabled={!!busy}>重新登录</button></div></form>}{notice && <div className="iw-notice" role="status"><Check size={17} />{notice}</div>}
      {!task && (showNew ? <TaskForm boot={boot} busy={!!busy} refresh={refresh} onError={setError} onCancel={() => setShowNew(false)} onCreate={data => void act('正在创建任务…', async () => select(await request<Task>('/tasks', data)))} /> : <TaskList account={user.account} version={version} disabled={!!busy} openTask={id => void act('正在打开任务…', async () => select(await request<Task>('/tasks/' + id)))} create={() => setShowNew(true)} demo={() => void act('正在准备合成样例…', async () => select(await request<Task>('/demo', {})))} />)}
      {task && <TaskScreen key={task.id} task={task} busy={busy} pending={pending.length} model={model} mesMode={boot.mes_mode} back={back} camera={openCamera} album={openAlbum} uploadNotice={uploadNotice} analyze={() => void act('正在加入识别队列…', () => mutate('/analyze', { model_id: model }))} stop={() => void act('正在暂停识别…', () => mutate('/stop'))} submit={() => void act('正在提交检测项…', () => mutate('/writeback', { revision: task.revision }))} remove={p => void act('正在移除照片…', () => mutate('/photos/' + p.id + '/delete'))} rotate={c => void act('正在调整方向…', () => mutate('/components/' + c.id + '/rotate'))} review={(c, verdict, reason) => act('正在保存复核…', () => mutate('/components/' + c.id + '/review', { verdict, reason }))} />}
      <footer className="iw-footer"><span>原图留存 · 逐件可追溯</span><button className="iw-text-button" onClick={() => setSettings(!settings)} aria-expanded={settings}><Settings2 size={16} />连接与模型</button></footer>
      {settings && <section className="iw-settings"><h2>连接与模型</h2><label>识别模型<select value={model} onChange={e => setModel(e.target.value)} disabled={working || !!busy}>{!model && <option value="">暂无可用模型</option>}{boot.models.filter(m => m.available).map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</select></label><p>识别任务由电脑排队处理。正式部署需接入企业登录和 MES 任务授权；当前账号仅用于本地试用。</p><div className="iw-actions"><button disabled={!!busy} onClick={() => void act('正在检查连接…', async () => { await refresh(); })}>重新检查连接</button><a href="/?view=chat" target="_blank" rel="noreferrer">打开图片对话与 Agent 工具</a></div></section>}
    </div><input ref={album} className="iw-file-input" type="file" accept="image/jpeg,image/png,image/webp" multiple={!replaceId} onChange={e => { picker(e.target.files); e.target.value = ''; }} /><input ref={systemCamera} className="iw-file-input" type="file" accept="image/*" capture="environment" onChange={e => { picker(e.target.files); e.target.value = ''; }} />
    {cameraOpen && <CaptureCamera count={task?.photos.length || 0} sampleCount={task?.summary.sample_count || 0} expected={task?.expected_count || 0} replacement={!!replaceId} blocked={pending.length > 0} onClose={() => setCameraOpen(false)} onSystem={() => { setCameraOpen(false); systemCamera.current?.click(); }} onPhoto={async file => { if (busyRef.current) throw new Error('上一张照片仍在保存。'); busyRef.current = true; const replacing = !!replacement.current; try { await upload([file]); if (replacing) setCameraOpen(false); } finally { busyRef.current = false; setBusy(''); } }} />}
    {busy && !task && <div className="iw-busy" role="status"><LoaderCircle size={18} className="iw-spinning" />{busy}</div>}
  </main>;
}

import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Camera, Check, ChevronRight, CircleCheck, Download, FlaskConical, ImagePlus, Layers, LoaderCircle, Plus, RotateCw, ScanLine, ShieldCheck, Square, Trash2, UserRound, X } from 'lucide-react';
import { api, ApiError, requestId } from '../api';
import { request, stateLabel, verdictLabel, type Bootstrap, type Component, type Photo, type Reference, type Task } from './api';
import { CaptureCamera } from './Camera';
import './style.css';

type PendingUpload = { file: File; requestId: string; replaceId: string; taskId: string };
const savedKey = 'sv-inspection-task';

export default function InspectionApp() {
  const [boot, setBoot] = useState<Bootstrap | null>(null), [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true), [connected, setConnected] = useState(true), [key, setKey] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('');
  const [showNew, setShowNew] = useState(false), [showProfile, setShowProfile] = useState(false), [settings, setSettings] = useState(false);
  const [model, setModel] = useState(''), [cameraOpen, setCameraOpen] = useState(false), [showSaved, setShowSaved] = useState(false);
  const [pending, setPending] = useState<PendingUpload[]>([]), [replaceId, setReplaceId] = useState('');
  const initialized = useRef(false), busyRef = useRef(false), selectedId = useRef<string | null>(null);
  const album = useRef<HTMLInputElement>(null), systemCamera = useRef<HTMLInputElement>(null);

  function select(t: Task | null) {
    selectedId.current = t?.id || null; setTask(t); setError(''); setNotice('');
    if (t) localStorage.setItem(savedKey, t.id); else localStorage.removeItem(savedKey);
    setShowNew(false); window.scrollTo({ top: 0 });
  }
  async function refresh() {
    const data = await request<Bootstrap>('/bootstrap'); setBoot(data);
    setModel(old => data.models.some(m => m.id === old && m.available) ? old : data.models.find(m => m.available && m.id === 'hr-qwen')?.id || data.models.find(m => m.available && /27b/i.test(m.id))?.id || data.models.find(m => m.available)?.id || '');
    return data;
  }
  async function initialize(token?: string) {
    setLoading(true); setError('');
    try {
      if (token) await api('/connect', { key: token });
      const data = await refresh(); setConnected(true); setShowProfile(!data.profile);
      if (token) history.replaceState(null, '', location.pathname);
      const previous = localStorage.getItem(savedKey);
      if (previous) { try { select(await request<Task>('/tasks/' + previous)); } catch { localStorage.removeItem(savedKey); } }
    } catch (e) { if (e instanceof ApiError && e.status === 401) setConnected(false); else setError((e as Error).message); }
    finally { setLoading(false); }
  }
  const initializeOnMount = useEffectEvent(initialize);
  useEffect(() => { if (initialized.current) return; initialized.current = true; void initializeOnMount(new URLSearchParams(location.hash.slice(1)).get('key') || undefined); }, []);
  const working = !!task && (['queued', 'running'].includes(task.run.status) || task.transfer?.status === 'sending');
  const locked = working || task?.transfer?.status === 'saved';
  const taskId = task?.id;
  useEffect(() => {
    if (!working || !taskId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const id = taskId;
    async function tick() {
      try { const t = await request<Task>('/tasks/' + id); if (!cancelled && selectedId.current === id) { setTask(t); setError(''); } }
      catch { if (!cancelled) setError('暂时连接不上电脑，已保存的照片不会丢失。正在重连…'); }
      if (!cancelled) timer = setTimeout(tick, 2200);
    }
    timer = setTimeout(tick, 1200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [working, taskId]);
  useEffect(() => {
    if (!pending.length) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [pending.length]);

  async function act(label: string, fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError((e as Error).message || '操作没有完成，请重试。'); }
    finally { busyRef.current = false; setBusy(''); }
  }
  async function mutate(suffix: string, data: object = {}) {
    if (!task) return;
    const t = await request<Task>(`/tasks/${task.id}${suffix}`, data); setTask(t); await refresh();
  }
  async function uploadItems(items: PendingUpload[]) {
    let remaining = [...items]; setPending(remaining);
    for (const item of items) {
      setBusy(`正在保存 ${item.file.name}…`);
      const form = new FormData(); form.append('file', item.file); form.append('request_id', item.requestId); form.append('replace_id', item.replaceId);
      try {
        const t = await request<Task>(`/tasks/${item.taskId}/photos`, form);
        if (selectedId.current === t.id) setTask(t);
      } catch (e) {
        // 重复文件是明确拒绝，无需一直保留在重试队列。
        if (e instanceof ApiError && e.status === 409 && e.message.includes('不会重复计数')) {
          remaining = remaining.slice(1); setPending(remaining); setNotice(e.message); continue;
        }
        throw e;
      }
      remaining = remaining.slice(1); setPending(remaining);
    }
    setReplaceId(''); setNotice('照片已保存，自动裁剪已完成。'); await refresh();
  }
  async function upload(files: File[], replacement = replaceId) {
    if (!task || !files.length) return;
    if (pending.length) throw new Error('请先重试或放弃尚未保存的照片。');
    await uploadItems(files.map(file => ({ file, requestId: requestId(), replaceId: replacement, taskId: task.id })));
  }
  function addFromPicker(fileList: FileList | null) {
    const files = Array.from(fileList || []); void act('正在保存照片…', () => upload(files));
  }
  function openCamera() {
    setReplaceId('');
    if (window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function') setCameraOpen(true);
    else systemCamera.current?.click();
  }
  async function openTask(id: string) { await act('正在打开任务…', async () => select(await request<Task>('/tasks/' + id))); }
  async function back() { await act('正在打开工作台…', async () => { await refresh(); select(null); }); }

  if (loading) return <main className="iw"><div className="iw-connection"><ScanLine size={34} /><h1>观微</h1><p>正在连接检验工作台…</p></div></main>;
  if (!connected) return <main className="iw"><div className="iw-connection"><ScanLine size={38} /><h1>连接检验工作台</h1><p>请扫描电脑上的连接二维码，或输入连接码。</p><form onSubmit={e => { e.preventDefault(); void initialize(key.trim()); }}><label>连接码<input value={key} onChange={e => setKey(e.target.value)} autoComplete="off" required /></label><button className="iw-primary">连接工作台<ArrowRight size={18} /></button></form>{error && <p role="alert">{error}</p>}</div></main>;
  if (!boot) return <main className="iw"><div className="iw-connection"><p role="alert">{error || '服务暂不可用'}</p><button onClick={() => void initialize()}>重新连接</button></div></main>;

  const hasResults = task?.photos.some(p => p.components.some(c => c.analysis || c.error));
  const resultsPanel = task && <Results task={task} locked={!!locked || !!busy} review={(c, verdict, reason) => void act('正在保存复核…', () => mutate('/components/' + c.id + '/review', { verdict, reason }))} rotate={c => void act('正在调整方向…', () => mutate('/components/' + c.id + '/rotate'))} />;
  const rows = boot.tasks.filter(t => showSaved ? t.transfer?.status === 'saved' : t.transfer?.status !== 'saved');
  return <main className="iw">
    <header className="iw-header"><a href="/" className="iw-brand" onClick={e => { e.preventDefault(); if (!busy && !pending.length) void back(); }}><span className="iw-brand-mark"><ScanLine size={25} /></span><strong>观微</strong><span className="iw-brand-description">丝印检验工作台</span></a>
      <div className="iw-header-actions"><span className="iw-environment">{boot.mes_mode === 'mock' ? '本地试用 · 模拟 MES' : 'MES 接口联调'}</span><button className="iw-icon-label" onClick={() => setShowProfile(!showProfile)} disabled={!!busy}><UserRound size={18} /><span>{boot.profile?.name || '设置检验员'}</span></button></div>
    </header>
    <div className="iw-shell">
      {error && <div className="iw-alert iw-error" role="alert"><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={18} /></button></div>}
      {notice && <div className="iw-notice" role="status"><Check size={17} />{notice}</div>}
      {showProfile && <ProfileForm boot={boot} busy={!!busy} onCancel={() => setShowProfile(false)} onSave={(employee_id, name) => void act('正在保存检验员…', async () => { await request('/profile', { employee_id, name }, 'PUT'); await refresh(); setShowProfile(false); })} />}
      {!task && <>
        <section className="iw-page-title"><div><p className="iw-eyebrow">来料检验 / SILKSCREEN</p><h1>从一张清晰的照片开始</h1><p>拍摄器件，核对异常，将检测结果保存到任务。</p></div><button className="iw-primary" onClick={() => setShowNew(!showNew)} disabled={!boot.profile || !!busy}><Plus size={20} />新建试用任务</button></section>
        {showNew && <TaskForm boot={boot} busy={!!busy} refresh={refresh} onError={setError} onCancel={() => setShowNew(false)} onCreate={data => void act('正在创建任务…', async () => { const t = await request<Task>('/tasks', data); await refresh(); select(t); })} />}
        <section className="iw-task-list"><div className="iw-section-head"><div className="iw-tabs" role="group" aria-label="任务筛选"><button className={!showSaved ? 'active' : ''} onClick={() => setShowSaved(false)}>进行中 <span>{boot.tasks.filter(t => t.transfer?.status !== 'saved').length}</span></button><button className={showSaved ? 'active' : ''} onClick={() => setShowSaved(true)}>已回填</button></div><button className="iw-text-button" onClick={() => void act('正在刷新…', async () => { await refresh(); })}>刷新</button></div>
          {rows.length ? rows.map(t => <button className="iw-task-row" key={t.id} onClick={() => void openTask(t.id)} disabled={!!busy || pending.length > 0}><span className="iw-row-icon"><Layers size={22} /></span><span className="iw-row-main"><strong>{t.number}</strong><span>{t.material}</span></span><span className="iw-row-count">{t.summary.sample_count} / {t.expected_count} 件</span><span className={'iw-badge ' + (t.summary.review_count || t.summary.error_count ? 'review' : '')}>{stateLabel(t)}</span><ChevronRight size={19} /></button>) : <div className="iw-empty"><Layers size={32} strokeWidth={1.4} /><h2>{showSaved ? '还没有回填的任务' : '工作台准备好了'}</h2><p>{showSaved ? '完成检验并回填后，可在这里查阅。' : '新建一个试用任务，或先用合成图片走一遍流程。'}</p>{!showSaved && <button onClick={() => void act('正在准备合成样例…', async () => { const t = await request<Task>('/demo', {}); await refresh(); select(t); })} disabled={!boot.profile || !!busy}><FlaskConical size={18} />试用合成样例</button>}</div>}
        </section>
        <div className="iw-workflow"><span><Camera size={19} />01 拍照采集</span><ArrowRight size={17} /><span><ScanLine size={19} />02 自动比对</span><ArrowRight size={17} /><span><ShieldCheck size={19} />03 核对回填</span></div>
      </>}
      {task && <>
        <button className="iw-back" onClick={() => void back()} disabled={!!busy || pending.length > 0}><ArrowLeft size={18} />全部任务</button>
        <section className="iw-task-heading"><div><p className="iw-eyebrow">{task.synthetic_test ? '合成测试任务 · 不代表真实器件' : '丝印检测项'}</p><h1>{task.number}</h1><p>{task.material} <span className="iw-divider">/</span> 检验员 {task.inspector.name}</p></div><span className="iw-badge">{stateLabel(task)}</span></section>
        <div className="iw-stepper" aria-label="任务进度">{['拍照采集', '自动比对', '异常复核', '回填结果'].map((label, i) => { const stage = task.transfer ? 3 : task.summary.review_count || task.summary.error_count || task.summary.can_submit ? 2 : task.run.status !== 'idle' ? 1 : 0; return <div key={label} className={i === stage ? 'current' : i < stage ? 'done' : ''}><span>{i < stage ? <Check size={14} /> : i + 1}</span>{label}</div>; })}</div>
        <div className="iw-task-layout">
          <div className="iw-content">
            {hasResults && resultsPanel}
            <section className="iw-capture-section"><div className="iw-section-head"><h2>采集照片 <span>{task.summary.photo_count} 张 · {task.summary.sample_count} 件</span></h2><span className="iw-muted">应检 {task.expected_count} 件</span></div>
              {!task.photos.length ? <div className="iw-empty iw-capture-empty"><Camera size={36} strokeWidth={1.4} /><h3>把器件放在纯色台面上</h3><p>{task.capture_mode === 'single' ? '一次拍一个，器件完整入镜，文字清晰可读。' : '每张最多四个，分开摆放，确保每个器件的文字都清晰。'}<br />系统会自动定位、裁剪并编号。</p><button onClick={openCamera} disabled={!!busy}><Camera size={18} />开始拍照</button></div> : <div className="iw-photos">{task.photos.map(p => <PhotoTile key={p.id} photo={p} locked={!!locked || !!busy || pending.length > 0} onDelete={() => void act('正在移除照片…', () => mutate('/photos/' + p.id + '/delete'))} onReplace={() => { setReplaceId(p.id); systemCamera.current?.click(); }} />)}</div>}
              {task.summary.sample_count !== task.expected_count && task.photos.length > 0 && <p className="iw-inline-warning">已定位 {task.summary.sample_count} 件，应检 {task.expected_count} 件。{task.summary.sample_count < task.expected_count ? '请继续添加照片，核对是否漏拍。' : '请核对是否重复拍摄，移除多余照片。'}</p>}
              {pending.length > 0 && <div className="iw-alert iw-warning"><div><strong>{pending.length} 张照片尚未确认保存</strong><p>请勿关闭页面。{busy ? busy : '网络恢复后可以继续上传。'}</p></div>{!busy && <div className="iw-actions"><button onClick={() => void act('正在重试上传…', () => uploadItems(pending))}>重试上传</button><button onClick={() => { setPending([]); setReplaceId(''); }}>放弃未保存照片</button></div>}</div>}
              {!locked && <div className="iw-add-photos"><button onClick={openCamera} disabled={!!busy || pending.length > 0}><Camera size={18} />{task.photos.length ? '继续拍照' : '打开相机'}</button><button onClick={() => { setReplaceId(''); album.current?.click(); }} disabled={!!busy || pending.length > 0}><ImagePlus size={18} />从相册添加</button><span>上传成功后自动保存草稿</span></div>}
            </section>
            {!hasResults && resultsPanel}
          </div>
          <aside className="iw-aside"><section className="iw-reference"><div className="iw-section-head"><h2>比对标准</h2><span className="iw-muted">v{task.reference.version}</span></div>{task.reference.image_url ? <img src={task.reference.image_url} alt="正品参考裁片" /> : <div className="iw-text-reference">仅文字标准<br /><small>不判断外形或颜色一致性</small></div>}<strong>{task.reference.name}</strong>{task.reference.text && <pre>{task.reference.text}</pre>}{task.reference.rules && <p>允许变化：{task.reference.rules}</p>}<small>标准已人工核对，当前任务使用固定版本。</small></section>
            <section className="iw-result-summary"><h2>本批检验</h2><div className="iw-summary-line"><span>通过</span><strong>{task.summary.pass_count} 件</strong></div><div className="iw-summary-line"><span>不合格</span><strong className={task.summary.fail_count ? 'iw-red' : ''}>{task.summary.fail_count} 件</strong></div><div className="iw-summary-line"><span>待复核 / 未完成</span><strong>{task.summary.review_count + task.summary.error_count + task.summary.pending_count} 件</strong></div><p>{task.summary.verdict === 'FAIL' ? (task.summary.can_submit ? '本批结论为不通过。全部样本已处理，可以保存本次结果。' : '已有不合格器件，本批结论为不通过。仍需处理其余样本后回填。') : task.summary.can_submit ? '数量已核对，全部样本已完成。可以保存丝印检测项。' : '完成全部样本并复核异常后，才能回填。'}</p><a className="iw-download" href={`/api/inspection/tasks/${task.id}/export`}><Download size={17} />下载当前报告与原图</a></section>
          </aside>
        </div>
        {task.run.error && <div className="iw-alert iw-warning">{task.run.error}</div>}
        {task.transfer && <section className={'iw-transfer ' + task.transfer.status} aria-live="polite"><CircleCheck size={25} /><div><strong>{task.transfer.status === 'saved' ? (task.transfer.mode === 'mock' ? '模拟回填已保存' : '丝印检测项已保存') : task.transfer.status === 'sending' ? '正在保存检测项与附件…' : '回填尚未确认'}</strong><p>{task.transfer.error || (task.transfer.status === 'saved' ? '整单还未提交。正式接入后，请在 MES 完成其他检验项并手动提交。' : '请等待保存回执。网络中断后可以用同一记录重试。')}</p>{task.transfer.receipt && <small>回执 {task.transfer.receipt.receipt_id}</small>}</div></section>}
        <div className="iw-bottom-bar"><div><strong>{busy || (task.run.status === 'running' ? `正在识别 ${task.run.current || '…'}` : task.run.status === 'queued' ? `等待识别 · 前面 ${task.run.ahead || 0} 个任务` : task.transfer?.status === 'saved' ? '本次检验已留档' : task.summary.can_submit ? '已具备回填条件' : '照片与任务草稿自动保存')}</strong><span>{task.run.started && task.run.queued_at ? `本次排队 ${Math.max(0, Math.round(task.run.started - task.run.queued_at))} 秒 · ` : ''}{task.auto_writeback ? '全部明确通过时自动回填；异常仍需复核' : '只保存丝印检测项，不代替 MES 整单提交'}</span></div>
          {['queued', 'running'].includes(task.run.status) ? <button onClick={() => void act('正在停止…', () => mutate('/stop'))} disabled={!!busy}><Square size={16} />停止识别</button> : task.transfer?.status === 'saved' ? <button onClick={() => void back()}>返回工作台<ArrowRight size={18} /></button> : task.summary.can_submit ? <button className="iw-primary" disabled={!!busy || working || pending.length > 0} onClick={() => void act('正在准备回填…', () => mutate('/writeback', { revision: task.revision }))}>{task.transfer?.status === 'failed' ? '重试回填' : boot.mes_mode === 'mock' ? '模拟回填检测项' : '回填丝印检测项'}<ArrowRight size={18} /></button> : task.summary.review_count > 0 && !task.summary.pending_count && !task.summary.error_count ? <button className="iw-primary" onClick={() => document.getElementById('iw-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>查看 {task.summary.review_count} 件待复核<ArrowRight size={18} /></button> : <button className="iw-primary" disabled={!!busy || !!locked || !task.summary.sample_count || !!task.summary.blocking_flags.length || pending.length > 0 || !model || (!task.summary.pending_count && !task.summary.error_count)} onClick={() => void act('正在加入识别队列…', () => mutate('/analyze', { model_id: model }))}><ScanLine size={19} />{task.run.status !== 'idle' ? '继续识别未完成项' : '完成拍摄并识别'}</button>}
        </div>
      </>}
      <footer className="iw-footer"><span>观微 · 本地处理，原图留存</span><div><button className="iw-text-button" onClick={() => setSettings(!settings)}>连接与模型</button><a href="/?view=chat">图片对话</a></div></footer>
      {settings && <section className="iw-settings"><label>当前识别模型<select value={model} onChange={e => setModel(e.target.value)} disabled={working}>{boot.models.filter(m => m.available).map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</select></label><p>{model ? '沿用 LM Studio 已加载模型，识别任务在电脑上排队执行。' : '没有可用视觉模型，请在电脑上启动 LM Studio 并加载模型。'} 当前为本地试用身份；公司部署时需对接企业登录和 MES 任务授权。</p><button onClick={() => void act('正在检查连接…', async () => { await refresh(); })}>重新检查连接</button></section>}
      {!model && <p className="iw-inline-warning">模型服务尚未就绪。可以先拍照保存，模型就绪后继续识别。</p>}
    </div>
    <input ref={album} className="iw-file-input" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e => { addFromPicker(e.target.files); e.target.value = ''; }} />
    <input ref={systemCamera} className="iw-file-input" type="file" accept="image/*" capture="environment" onChange={e => { addFromPicker(e.target.files); e.target.value = ''; }} />
    {cameraOpen && <CaptureCamera count={task?.photos.length || 0} onClose={() => setCameraOpen(false)} onPhoto={async file => { if (busyRef.current) throw new Error('上一张照片仍在保存。'); busyRef.current = true; try { await upload([file], ''); } finally { busyRef.current = false; setBusy(''); } }} />}
    {busy && !task && <div className="iw-busy" role="status"><LoaderCircle size={18} />{busy}</div>}
  </main>;
}

function ProfileForm({ boot, busy, onSave, onCancel }: { boot: Bootstrap; busy: boolean; onSave: (id: string, name: string) => void; onCancel: () => void }) {
  const [id, setId] = useState(boot.profile?.employee_id || ''), [name, setName] = useState(boot.profile?.name || '');
  return <form className="iw-form-panel" onSubmit={e => { e.preventDefault(); onSave(id.trim(), name.trim()); }}><div className="iw-section-head"><h2>先记录本次试用人员</h2>{boot.profile && <button type="button" onClick={onCancel} aria-label="关闭人员设置"><X size={18} /></button>}</div><p>用于本地检验记录。正式上线时换成公司账号登录。</p><div className="iw-form-grid"><label>工号<input value={id} onChange={e => setId(e.target.value)} required maxLength={60} placeholder="例如 A001" /></label><label>姓名<input value={name} onChange={e => setName(e.target.value)} required maxLength={60} placeholder="检验员姓名" /></label></div><button className="iw-primary" disabled={busy || !id.trim() || !name.trim()}>保存检验员<Check size={18} /></button></form>;
}

function TaskForm({ boot, busy, refresh, onError, onCancel, onCreate }: { boot: Bootstrap; busy: boolean; refresh: () => Promise<Bootstrap>; onError: (message: string) => void; onCancel: () => void; onCreate: (data: object) => void }) {
  const [refId, setRefId] = useState(boot.references[0]?.id || ''), [addingRef, setAddingRef] = useState(!boot.references.length);
  const [number, setNumber] = useState(''), [material, setMaterial] = useState(''), [count, setCount] = useState(''), [multi, setMulti] = useState(false), [auto, setAuto] = useState(false);
  return <section className="iw-form-panel"><div className="iw-section-head"><h2>新建试用任务</h2><button onClick={onCancel} aria-label="关闭新建任务"><X size={18} /></button></div><p>与 MES 接通前，先手动填写单号；请核对实物与任务一致。</p>
    <form onSubmit={e => { e.preventDefault(); onCreate({ number: number.trim(), material: material.trim(), expected_count: Number(count), reference_id: refId, capture_mode: multi ? 'multi' : 'single', auto_writeback: auto }); }}>
      <div className="iw-form-grid"><label>检验任务单号<input value={number} onChange={e => setNumber(e.target.value)} placeholder="填写检验单号" maxLength={100} required /></label><label>物料名称 / 编码<input value={material} onChange={e => setMaterial(e.target.value)} placeholder="例如 IC-358 / SOIC-8" maxLength={150} required /></label><label>本次应检数量<input type="number" inputMode="numeric" min={1} max={100} value={count} onChange={e => setCount(e.target.value)} placeholder="按器件数填写" required /></label><label>正品标准<select value={refId} onChange={e => setRefId(e.target.value)} required><option value="">选择已核对的标准</option>{boot.references.map(r => <option value={r.id} key={r.id}>{r.name} · v{r.version}{r.image_url ? '' : '（仅文字）'}</option>)}</select></label></div>
      <button className="iw-text-button" type="button" onClick={() => setAddingRef(!addingRef)}>{addingRef ? '收起标准创建' : '＋ 创建新的正品标准'}</button>
      <div className="iw-options"><label><input type="checkbox" checked={multi} onChange={e => setMulti(e.target.checked)} />允许一张多件（最多四件，需清晰且分开摆放）</label><label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />全部明确通过后自动回填；异常仍由我复核</label></div>
      <button className="iw-primary" disabled={busy || !refId || !number.trim() || !material.trim() || !Number(count)}>创建并开始拍照<ArrowRight size={18} /></button>
    </form>
    {addingRef && <ReferenceForm onError={onError} onSaved={async ref => { await refresh(); setRefId(ref.id); setAddingRef(false); }} />}
  </section>;
}

function ReferenceForm({ onSaved, onError }: { onSaved: (ref: Reference) => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState(''), [text, setText] = useState(''), [rules, setRules] = useState(''), [file, setFile] = useState<File | null>(null), [approved, setApproved] = useState(false), [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) { e.preventDefault(); setSaving(true); onError(''); try { const form = new FormData(); form.append('name', name); form.append('text', text); form.append('rules', rules); form.append('approved', String(approved)); if (file) form.append('file', file); await onSaved(await request<Reference>('/references', form)); } catch (e) { onError((e as Error).message); } finally { setSaving(false); } }
  return <form className="iw-reference-form" onSubmit={e => void submit(e)}><h3>建立正品标准</h3><p>推荐上传纯色背景、单件且清晰的正品照片。每次创建都会保留独立记录。</p><div className="iw-form-grid"><label>标准名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="例如 SV358 · 来料标准" /></label><label>正品照片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] || null)} /></label><label>核对过的丝印文字<textarea rows={3} value={text} onChange={e => setText(e.target.value)} maxLength={4000} placeholder="逐行填写，可留空。只有文字时，仅核对文字。" /></label><label>允许变化的内容<textarea rows={3} value={rules} onChange={e => setRules(e.target.value)} maxLength={2000} placeholder="例如第 3 行为批号，可不同；留空则不忽略任何差异。" /></label></div><label className="iw-checkbox"><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />我已确认资料来自正品，文字与允许变化规则准确</label><button disabled={saving || !approved || (!text.trim() && !file)}>{saving ? '正在保存标准…' : '保存标准'}</button></form>;
}

function PhotoTile({ photo, locked, onDelete, onReplace }: { photo: Photo; locked: boolean; onDelete: () => void; onReplace: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return <article className="iw-photo"><a href={photo.original_url} target="_blank" rel="noreferrer" aria-label={`查看 ${photo.label} 原图`}><img src={photo.annotation_url} alt={`${photo.label}，定位 ${photo.components.length} 个器件`} loading="lazy" /></a><div className="iw-photo-caption"><strong>{photo.label}</strong><span>{photo.components.length} 件</span></div>{photo.flags.map(f => <p className="iw-photo-warning" key={f}>{f}</p>)}{!locked && <div className="iw-photo-actions">{confirm ? <><button className="iw-red" onClick={onDelete}>确认移除</button><button onClick={() => setConfirm(false)}>保留</button></> : <><button onClick={onReplace}><Camera size={15} />重拍</button><button onClick={() => setConfirm(true)} aria-label={`移除 ${photo.label}`}><Trash2 size={16} /></button></>}</div>}</article>;
}

function Results({ task, locked, review, rotate }: { task: Task; locked: boolean; review: (c: Component, v: 'PASS' | 'FAIL', reason: string) => void; rotate: (c: Component) => void }) {
  const parts = task.photos.flatMap(p => p.components), issues = parts.filter(c => ['REVIEW', 'ERROR'].includes(c.final_verdict));
  const rest = parts.filter(c => !['REVIEW', 'ERROR'].includes(c.final_verdict));
  if (!parts.length) return null;
  return <section className="iw-results" id="iw-results"><div className="iw-section-head"><h2>{issues.length ? '请先核对这些器件' : '器件与识别结果'} <span>{issues.length ? `${issues.length} 件待处理` : `${parts.length} 件`}</span></h2></div>{issues.map(c => <ComponentDetail key={c.id} component={c} reference={task.reference} locked={locked} review={review} rotate={rotate} />)}{rest.map(c => <details key={c.id} className="iw-component-row"><summary><img src={c.image_url} alt="" /><strong>{c.label}</strong><span className={'iw-badge ' + c.final_verdict.toLowerCase()}>{verdictLabel[c.final_verdict]}</span><ChevronRight size={18} /></summary><ComponentDetail component={c} reference={task.reference} locked={locked} review={review} rotate={rotate} /></details>)}</section>;
}

function ComponentDetail({ component: c, reference, locked, review, rotate }: { component: Component; reference: Reference; locked: boolean; review: (c: Component, v: 'PASS' | 'FAIL', reason: string) => void; rotate: (c: Component) => void }) {
  const [reason, setReason] = useState('');
  return <article className="iw-component"><div className="iw-section-head"><h3>{c.label}</h3><span className={'iw-badge ' + c.final_verdict.toLowerCase()}>{verdictLabel[c.final_verdict]}</span></div><div className="iw-comparison"><figure>{reference.image_url ? <a href={reference.image_url} target="_blank" rel="noreferrer"><img src={reference.image_url} alt="正品参考" /></a> : <pre>{reference.text}</pre>}<figcaption>正品标准</figcaption></figure><figure><a href={c.image_url} target="_blank" rel="noreferrer"><img src={c.image_url} alt={c.label + ' 待检裁片'} /></a><figcaption>待检器件 · {c.label}</figcaption></figure></div>
    {c.quality_flags.map(f => <p className="iw-inline-warning" key={f}>{f}</p>)}
    {c.analysis && <div className="iw-evidence"><p>{c.analysis.summary}</p><dl><dt>识别文字</dt><dd>{c.analysis.observed_text.join(' / ') || '未读到文字'}</dd></dl>{c.analysis.differences.map((d, i) => <div className="iw-difference" key={i}><strong>{d.description}</strong><div><span>标准：{d.reference}</span><span>待检：{d.sample}</span></div></div>)}{c.analysis.uncertainties.map(s => <p className="iw-inline-warning" key={s}>{s}</p>)}{c.analysis.features.length > 0 && <details className="iw-feature-details"><summary>查看外观观察</summary><p>{c.analysis.features.join('；')}</p></details>}{c.model_metadata && <small>模型建议：{verdictLabel[c.analysis.verdict]} · 本件识别 {c.model_metadata.seconds} 秒</small>}</div>}
    {c.error && <p className="iw-inline-warning">{c.error} 可以继续识别，或根据清晰的原图人工复核。</p>}
    {c.review && <div className="iw-reviewed"><Check size={17} /><span>{c.review.operator.name} 已确认{verdictLabel[c.review.verdict]}：{c.review.reason}</span></div>}
    {!locked && <div className="iw-component-controls"><button className="iw-text-button" onClick={() => rotate(c)}><RotateCw size={16} />旋转 90°（需重新识别）</button>{(c.analysis || c.error) && <div className="iw-review-form"><label>复核说明<textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="说明确认依据，至少 5 个字" maxLength={500} /></label><div className="iw-actions"><button disabled={reason.trim().length < 5} onClick={() => review(c, 'PASS', reason.trim())}>确认通过</button><button className="iw-danger-outline" disabled={reason.trim().length < 5} onClick={() => review(c, 'FAIL', reason.trim())}>确认不合格</button></div></div>}</div>}
  </article>;
}

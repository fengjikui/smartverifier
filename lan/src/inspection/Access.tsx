import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Eye, EyeOff, LockKeyhole, ScanLine } from 'lucide-react';
import { api, ApiError } from '../api';
import { request } from './api';
export type TrialUser = { account: string; name: string };

export function Access({ children }: { children: (user: TrialUser, logout: () => Promise<void>) => ReactNode }) {
  const [user, setUser] = useState<TrialUser | null>(null), [loading, setLoading] = useState(true), [paired, setPaired] = useState(true);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [signup, setSignup] = useState(false), [showPassword, setShowPassword] = useState(false);
  const [account, setAccount] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(''), [key, setKey] = useState('');
  const initialized = useRef(false);
  async function check(token?: string) {
    setError(''); setLoading(true);
    try {
      if (token) { await api('/connect', { key: token }); history.replaceState(null, '', location.pathname); }
      const data = await request<{ user: TrialUser | null }>('/auth/status'); setPaired(true); setUser(data.user);
    } catch (e) { if (e instanceof ApiError && e.status === 401) setPaired(false); else setError((e as Error).message); }
    finally { setLoading(false); }
  }
  const init = useEffectEvent(check);
  useEffect(() => { if (initialized.current) return; initialized.current = true; void init(new URLSearchParams(location.hash.slice(1)).get('key') || undefined); }, []);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await request('/auth/' + (signup ? 'register' : 'login'), { account: account.trim(), password, ...(signup ? { name: name.trim() } : {}) }); setPassword(''); await check(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function logout() { await request('/auth/logout', {}); setUser(null); setPassword(''); setError(''); }
  if (user) return <>{children(user, logout)}</>;
  return <main className="iw iw-login"><section className="iw-login-brand"><div className="iw-brand"><ScanLine size={34} /><strong>观微</strong></div><div><h1>每一件，<br />都有据可查。</h1><p>来料丝印检验工作台</p><ol><li>拍摄器件</li><li>核对差异</li><li>保存检测结果</li></ol></div><small>平板拍照 · 原图留存 · 逐件追溯</small></section>
    <section className="iw-login-main"><div className="iw-login-form"><span className="iw-badge">本地试用</span><h2>{loading ? '正在连接工作台' : !paired ? '连接这台设备' : signup ? '创建试用账号' : '登录检验工作台'}</h2><p>{!paired ? '扫描电脑连接二维码，或输入连接码，完成一次配对。' : '登录后选择待检任务，开始拍照。'}</p>
      {error && <div className="iw-alert iw-error" role="alert">{error}</div>}
      {loading ? <div className="iw-skeleton" aria-label="正在加载" /> : !paired ? <form onSubmit={e => { e.preventDefault(); void check(key.trim()); }}><label>设备连接码<input value={key} onChange={e => setKey(e.target.value)} autoComplete="off" required /></label><button className="iw-primary">连接设备<ArrowRight size={18} /></button></form> : <form onSubmit={e => void submit(e)}>
        <label>账号<input autoComplete="username" value={account} onChange={e => setAccount(e.target.value)} required pattern="[A-Za-z0-9_.@\-]+" minLength={2} maxLength={60} placeholder="检验员账号" /></label>
        {signup && <label>姓名<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={60} placeholder="用于记录复核人" /></label>}
        <label>密码<span className="iw-password"><input autoComplete={signup ? 'new-password' : 'current-password'} type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} minLength={8} maxLength={128} required placeholder="至少 8 位" /><button type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={20} /> : <Eye size={20} />}</button></span></label>
        <button className="iw-primary" disabled={busy}>{busy ? '正在处理…' : signup ? '创建并进入工作台' : '登录'}<ArrowRight size={18} /></button>
        <p className="iw-login-hint"><LockKeyhole size={15} />请设置独立的试用密码，不要使用 MES 密码。</p>
        <button type="button" className="iw-text-button" disabled={busy} onClick={() => { setSignup(!signup); setError(''); }}>{signup ? '已有试用账号，返回登录' : '首次使用？创建本地试用账号'}</button>
      </form>}{error && paired && <button className="iw-text-button" onClick={() => void check()}>重新检查连接</button>}</div></section>
  </main>;
}

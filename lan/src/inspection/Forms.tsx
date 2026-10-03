import { useState, type FormEvent } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { request, type Bootstrap, type Reference } from './api';

export function TaskForm({ boot, busy, refresh, onError, onCancel, onCreate }: { boot: Bootstrap; busy: boolean; refresh: () => Promise<Bootstrap>; onError: (message: string) => void; onCancel: () => void; onCreate: (data: object) => void }) {
  const [refId, setRefId] = useState(boot.references[0]?.id || ''), [addingRef, setAddingRef] = useState(!boot.references.length);
  const [number, setNumber] = useState(''), [material, setMaterial] = useState(''), [count, setCount] = useState(''), [multi, setMulti] = useState(false), [auto, setAuto] = useState(false);
  return <section className="iw-form-panel"><div className="iw-section-head"><h2>新建试用任务</h2><button onClick={onCancel} aria-label="关闭新建任务"><X size={18} /></button></div><p>与 MES 接通前，先手动填写单号；请核对实物与任务一致。</p>
    <form onSubmit={e => { e.preventDefault(); onCreate({ number: number.trim(), material: material.trim(), expected_count: Number(count), reference_id: refId, capture_mode: multi ? 'multi' : 'single', auto_writeback: auto }); }}>
      <div className="iw-form-grid"><label>检验任务单号<input value={number} onChange={e => setNumber(e.target.value)} placeholder="填写检验单号" maxLength={100} required /></label><label>物料名称 / 编码<input value={material} onChange={e => setMaterial(e.target.value)} placeholder="例如 IC-358 / SOIC-8" maxLength={150} required /></label><label>本次应检数量<input type="number" inputMode="numeric" min={1} max={100} value={count} onChange={e => setCount(e.target.value)} placeholder="按器件数填写" required /></label><label>正品标准<select value={refId} onChange={e => setRefId(e.target.value)} required><option value="">选择已核对的标准</option>{boot.references.map(r => <option value={r.id} key={r.id}>{r.name} · v{r.version}{r.image_url ? '' : '（仅文字）'}</option>)}</select></label></div>
      <button className="iw-text-button" type="button" onClick={() => setAddingRef(!addingRef)}>{addingRef ? '收起标准创建' : '＋ 创建新的正品标准'}</button>
      <div className="iw-options"><label><input type="checkbox" checked={multi} onChange={e => setMulti(e.target.checked)} />允许一张多件（最多四件，需清晰且分开摆放）</label><label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />全部明确通过后自动回填；异常仍由我复核</label></div>
      <button className="iw-primary" disabled={busy || !refId || !number.trim() || !material.trim() || !Number(count)}>创建检验任务<ArrowRight size={18} /></button>
    </form>
    {addingRef && <ReferenceForm onError={onError} onSaved={async ref => { await refresh(); setRefId(ref.id); setAddingRef(false); }} />}
  </section>;
}

function ReferenceForm({ onSaved, onError }: { onSaved: (ref: Reference) => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState(''), [text, setText] = useState(''), [rules, setRules] = useState(''), [file, setFile] = useState<File | null>(null), [approved, setApproved] = useState(false), [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) { e.preventDefault(); setSaving(true); onError(''); try { const form = new FormData(); form.append('name', name); form.append('text', text); form.append('rules', rules); form.append('approved', String(approved)); if (file) form.append('file', file); await onSaved(await request<Reference>('/references', form)); } catch (e) { onError((e as Error).message); } finally { setSaving(false); } }
  return <form className="iw-reference-form" onSubmit={e => void submit(e)}><h3>建立正品标准</h3><p>推荐上传纯色背景、单件且清晰的正品照片。每次创建都会保留独立记录。</p><div className="iw-form-grid"><label>标准名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="例如 SV358 · 来料标准" /></label><label>正品照片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] || null)} /></label><label>核对过的丝印文字<textarea rows={3} value={text} onChange={e => setText(e.target.value)} maxLength={4000} placeholder="逐行填写，可留空。只有文字时，仅核对文字。" /></label><label>允许变化的内容<textarea rows={3} value={rules} onChange={e => setRules(e.target.value)} maxLength={2000} placeholder="例如第 3 行为批号，可不同；留空则不忽略任何差异。" /></label></div><label className="iw-checkbox"><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />我已确认资料来自正品，文字与允许变化规则准确</label><button disabled={saving || !approved || (!text.trim() && !file)}>{saving ? '正在保存标准…' : '保存标准'}</button></form>;
}

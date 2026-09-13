import { useEffect, useRef, useState } from "react";
import { Aperture, ArrowUp, Camera, Check, ChevronDown, Crop, History, ImagePlus, LoaderCircle, Maximize, MessageCircle, Plus, RefreshCw, Scan, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ViewportEditor } from "./ViewportEditor";
import { api, ApiError, defaultViewport, requestId, type Chat, type ChatSummary, type Model, type Photo, type View, type Viewport } from "./api";

export default function App() {
  const [connected, setConnected] = useState(false), [booting, setBooting] = useState(true), [key, setKey] = useState("");
  const [models, setModels] = useState<Model[]>([]), [model, setModel] = useState(() => localStorage.getItem("sv-model") || "");
  const [chats, setChats] = useState<ChatSummary[]>([]), [chat, setChat] = useState<Chat | null>(null), [history, setHistory] = useState(false);
  const [photo, setPhoto] = useState<Photo | null>(null), [view, setView] = useState<View | null>(null);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState<Viewport>(defaultViewport);
  const [text, setText] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [jobStatus, setJobStatus] = useState(""), [jobError, setJobError] = useState("");
  const camera = useRef<HTMLInputElement>(null), album = useRef<HTMLInputElement>(null), end = useRef<HTMLDivElement>(null);
  const pendingRequest = useRef<{ body: object; fingerprint: string } | null>(null);
  const initialized = useRef(false);
  const working = !!chat?.active_job;
  const selectedModel = models.find(m => m.id === model);

  async function refreshModels() {
    const result = await api<{ models: Model[]; error?: string }>("/models");
    setModels(result.models);
    setModel(old => result.models.some(m => m.id === old && m.available) ? old : result.models.find(m => m.available && m.id.includes("4b"))?.id || result.models.find(m => m.available)?.id || "");
    if (result.error) setError(result.error);
  }
  async function refreshChats() { setChats((await api<{ chats: ChatSummary[] }>("/chats")).chats); }
  async function loadChat(id: string) {
    const result = await api<Chat>(`/chats/${id}`);
    setChat(result); setPhoto(result.image || null); setView(result.view || null); setEditing(false); setHistory(false); setJobError("");
    localStorage.setItem("sv-chat", id);
  }
  async function initialize(connectKey?: string) {
    setBooting(true); setError("");
    try {
      if (connectKey) await api("/connect", { key: connectKey });
      await refreshChats(); setConnected(true);
      await refreshModels();
      const previous = localStorage.getItem("sv-chat");
      if (previous) await loadChat(previous).catch(() => localStorage.removeItem("sv-chat"));
      if (connectKey) window.history.replaceState(null, "", location.pathname);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setConnected(false);
      else setError((e as Error).message || "连接电脑失败，请确认手机和电脑在同一局域网。");
    } finally { setBooting(false); }
  }
  useEffect(() => { if (initialized.current) return; initialized.current = true; const token = new URLSearchParams(location.hash.slice(1)).get("key"); void initialize(token || undefined); }, []); // First device pairing, then HttpOnly session cookie.
  useEffect(() => { if (model) localStorage.setItem("sv-model", model); }, [model]);
  useEffect(() => {
    if (!chat?.active_job) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const id = chat.active_job, chatId = chat.id;
    const tick = async () => {
      try {
        const result = await api<{ status: string; error?: string }>(`/jobs/${id}`);
        if (stopped) return;
        setJobStatus(result.status);
        if (["completed", "failed", "cancelled"].includes(result.status)) {
          const updated = await api<Chat>(`/chats/${chatId}`);
          if (!stopped) { setChat(updated); setJobError(result.error || ""); void refreshChats(); }
          return;
        }
      } catch { if (!stopped) setJobStatus("reconnecting"); }
      if (!stopped) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [chat?.active_job, chat?.id]);
  useEffect(() => { if (chat?.messages.length) end.current?.scrollIntoView({ block: "nearest" }); }, [chat?.messages.length]);

  async function upload(file?: File) {
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) { setError("照片超过 64 MB，请使用普通拍照模式。"); return; }
    setBusy("正在上传原图…"); setError("");
    try {
      const form = new FormData(); form.append("file", file);
      const result = await api<Photo>("/images", form);
      const rendered = await api<View>("/views", { image_id: result.id, viewport: defaultViewport });
      setPhoto(result); setView(rendered); setEditing(false); setDraft(defaultViewport);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }
  async function applyViewport(settings: Viewport) {
    if (!photo) return;
    setBusy("正在生成取景图片…"); setError("");
    try { setView(await api<View>("/views", { image_id: photo.id, viewport: settings })); setEditing(false); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }
  function newChat() { setChat(null); setPhoto(null); setView(null); setText(""); setEditing(false); setHistory(false); setError(""); setJobError(""); localStorage.removeItem("sv-chat"); }
  async function send(question = text) {
    if (!question.trim() || !model || busy || working || editing) return;
    setBusy("发送中…"); setError(""); setJobError("");
    const input = { chat_id: chat?.id || null, view_id: view?.id || null, model, text: question.trim() };
    const fingerprint = JSON.stringify(input);
    if (pendingRequest.current?.fingerprint !== fingerprint) pendingRequest.current = { fingerprint, body: { ...input, request_id: requestId() } };
    try {
      const result = await api<{ chat_id: string; job_id: string }>("/chat", pendingRequest.current.body);
      const updated = await api<Chat>(`/chats/${result.chat_id}`);
      setChat(updated); setText(""); setJobStatus("queued"); localStorage.setItem("sv-chat", updated.id); pendingRequest.current = null;
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }
  async function stop() { if (chat?.active_job) { await api(`/jobs/${chat.active_job}/cancel`, {}).catch(e => setError(e.message)); } }
  const pickPhoto = (source: "camera" | "album") => (source === "camera" ? camera : album).current?.click();

  if (!connected) return <main className="connect-page"><div className="brand-icon"><Aperture size={29}/></div><span className="eyebrow">SMARTVERIFIER · LOCAL</span><h1>把细节，看清楚。</h1><p>连接你的电脑，用手机拍照、取景，<br/>再和本地模型聊一聊。</p>{booting ? <p role="status"><LoaderCircle className="spin" size={18}/> 正在连接…</p> : <form onSubmit={e => { e.preventDefault(); let value = key.trim(); try { value = new URLSearchParams(new URL(value).hash.slice(1)).get("key") || value; } catch {} void initialize(value); }}><label htmlFor="pair-key">扫描电脑上的二维码，或粘贴连接码</label><input id="pair-key" value={key} onChange={e => setKey(e.target.value)} placeholder="粘贴连接码或完整链接" autoComplete="off"/><Button type="submit" className="primary" disabled={!key.trim()}>连接电脑</Button></form>}{error && <p className="error" role="alert">{error}</p>}<small>手机与电脑需要连接同一个局域网</small></main>;

  return <div className="app-shell">
    <header className="app-header"><div className="identity"><span className="brand-icon"><Aperture size={22}/></span><div><strong>观微<span>看图聊一聊</span></strong><small><i/> 本地模型 · 局域网连接</small></div></div><div className="header-actions"><Button variant="ghost" size="icon" aria-label="查看历史对话" aria-expanded={history} onClick={() => { setHistory(!history); void refreshChats(); }}><History/></Button><Button variant="ghost" size="icon" aria-label="新建对话" onClick={newChat}><Plus/></Button></div></header>
    <div className="model-bar"><span>当前模型</span><div className="model-select"><select aria-label="选择识别模型" value={model} onChange={e => setModel(e.target.value)} disabled={working}>{models.length ? models.map(m => <option key={m.id} value={m.id} disabled={!m.available}>{m.name} · {m.size}{!m.available ? "（待适配）" : ""}</option>) : <option value="">没有可用模型</option>}</select><ChevronDown size={14}/></div><Button variant="ghost" size="icon" aria-label="刷新模型列表" onClick={() => { setError(""); void refreshModels().catch(e => setError(e.message)); }}><RefreshCw size={16}/></Button></div>
    {history && <section className="history-panel"><div className="section-heading"><h2>最近对话</h2><Button variant="ghost" size="icon" aria-label="关闭历史" onClick={() => setHistory(false)}><X/></Button></div>{chats.length ? chats.map(item => <button className="history-item" key={item.id} onClick={() => void loadChat(item.id).catch(e => setError(e.message))}><MessageCircle size={18}/><span>{item.title}</span><small>{new Date(item.updated * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small></button>) : <p className="subtle">发送第一条问题后，对话会保存在电脑上。</p>}</section>}
    {error && <div className="notice error" role="alert"><span>{error}</span><Button variant="ghost" size="icon" aria-label="关闭提示" onClick={() => setError("")}><X size={16}/></Button></div>}
    <main className="workspace">
      <section className={`photo-workspace ${editing ? "is-editing" : ""}`} aria-label="图片工作区">
        <div className="section-heading"><h2>{editing ? "调整取景" : photo ? "当前图片" : "从一张照片开始"}</h2>{photo && <span className="photo-size">{photo.width} × {photo.height}</span>}</div>
        {!photo ? <div className="empty-photo"><div className="reticle"><Scan size={72} strokeWidth={1}/><ImagePlus size={26}/></div><h3>拍下来，细看一下</h3><p>包装文字、元件丝印、难辨的小细节</p><div className="capture-actions"><Button className="primary" onClick={() => pickPhoto("camera")} disabled={!!busy}><Camera size={19}/> 拍一张</Button><Button variant="outline" className="secondary" onClick={() => pickPhoto("album")} disabled={!!busy}><ImagePlus size={19}/> 从相册选</Button></div><small>原图保存在电脑上，准备好后再发送识别</small></div> : <>
          <div className="view-tabs" role="group" aria-label="发送图片范围"><button aria-pressed={!editing && view?.mode === "whole"} disabled={!!busy || working} onClick={() => void applyViewport(defaultViewport)}><Maximize size={16}/> 整张图片</button><button aria-pressed={editing || view?.mode === "crop"} disabled={!!busy || working} onClick={() => { setDraft(view?.mode === "crop" ? view.settings : { ...defaultViewport, mode: "crop" }); setEditing(true); }}><Crop size={16}/> 取景裁剪</button></div>
          {editing ? <ViewportEditor photo={photo} value={draft} busy={!!busy} onChange={setDraft} onCancel={() => setEditing(false)} onApply={() => void applyViewport(draft)}/> : <><div className="sent-view"><img src={view?.url || photo.preview_url} alt={view?.mode === "crop" ? "实际发送给模型的局部取景图片" : "实际发送给模型的整张图片"}/><span className="view-badge">{view?.mode === "crop" ? "仅发送取景范围" : "发送整张图片"}</span></div><div className="photo-caption"><span><Check size={14}/> 模型将看到这张图</span><button onClick={() => pickPhoto("album")} disabled={!!busy || working}>更换照片</button></div></>}
        </>}
        {busy && <div className="progress-note" role="status"><LoaderCircle className="spin" size={17}/>{busy}</div>}
      </section>
      <section className="conversation" aria-label="与模型的对话"><div className="section-heading"><h2>一起看看</h2><span className="subtle">可连续追问</span></div>
        {!chat?.messages.length ? <div className="chat-empty"><div className="assistant-mark"><Aperture size={20}/></div><p>选好图片后，告诉我你想看什么。</p><span>可以先读文字，也可以关注某个细节。</span><div className="suggestions">{["请逐行识别图片中的文字", "哪些地方看不清楚？", "描述这个物品的外观特征"].map(prompt => <button key={prompt} onClick={() => setText(prompt)}>{prompt}</button>)}</div></div> : <div className="messages">{chat.messages.map(message => <article key={message.id} className={`message ${message.role}`}><div className="message-label">{message.role === "user" ? "你" : <><Aperture size={16}/> 观微</>}{message.status === "failed" && <small>发送未完成</small>}{message.status === "cancelled" && <small>已停止</small>}</div>{message.role === "user" && message.view_id && <a className="message-image" href={`/api/views/${message.view_id}/image`} target="_blank" rel="noreferrer"><img src={`/api/views/${message.view_id}/image`} alt="本条问题使用的实际图片" loading="lazy"/></a>}<div className="message-text">{message.text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part)}</div>{message.partial && <p className="partial-note">回答达到本次长度上限，可以继续追问。</p>}{message.role === "assistant" && <div className="message-meta">{message.model} · {message.seconds?.toFixed(1)} 秒</div>}{["failed", "cancelled"].includes(message.status) && !working && <button className="retry" onClick={() => void send(message.text)}>重新发送</button>}</article>)}</div>}
        {working && <div className="thinking" role="status"><LoaderCircle className="spin" size={17}/><span>{jobStatus === "queued" ? "正在等待电脑处理…" : jobStatus === "reconnecting" ? "正在恢复连接，任务仍保留在电脑上…" : "正在查看图片…"}</span><button onClick={() => void stop()}><Square size={12}/> 停止</button></div>}
        {jobError && <p className="notice" role="status">{jobError}</p>}<div ref={end}/>
        <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="输入问题" placeholder={view ? "想了解这张图的什么？" : "先选一张图片，或直接提问…"} value={text} maxLength={2000} onChange={e => setText(e.target.value)} rows={2} onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}/><div className="composer-actions"><div><Button type="button" variant="ghost" size="icon" aria-label="拍照添加图片" onClick={() => pickPhoto("camera")} disabled={working || !!busy}><Camera size={20}/></Button><Button type="button" variant="ghost" size="icon" aria-label="从相册添加图片" onClick={() => pickPhoto("album")} disabled={working || !!busy}><ImagePlus size={20}/></Button><span>{view?.mode === "crop" ? "当前取景" : view ? "整张图片" : "还未选图"}</span></div><Button type="submit" className="send-button" aria-label="发送问题" disabled={!text.trim() || !selectedModel?.available || !!busy || working || editing}><ArrowUp size={21}/></Button></div><p className="context-note">保留最近对话，视觉判断以当前图片为准</p></form>
      </section>
    </main><input ref={camera} type="file" accept="image/*" capture="environment" className="visually-hidden" aria-label="使用手机相机拍照" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }}/><input ref={album} type="file" accept="image/jpeg,image/png,image/webp" className="visually-hidden" aria-label="选择相册照片" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }}/>
    <footer className="app-footer">观微 · 图片留在局域网，细节交给你判断</footer>
  </div>;
}

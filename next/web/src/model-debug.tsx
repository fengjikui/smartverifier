import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Play, Search, Copy, Download, ChevronRight, Activity } from 'lucide-react';
import { ApiError, request } from './api';
import type { TraceEvent, TraceSummary } from '../../shared/model-trace';
import './model-debug.css';

const seconds=(value:number|undefined|null)=>value==null?'未记录':`${(value/1000).toFixed(2)} s`;
const statusText={running:'进行中',valid:'校验通过',invalid:'校验未通过',error:'调用失败',interrupted:'已中断'};
function JsonBlock({value}:{value:unknown}){return <pre className="md-json">{JSON.stringify(value,null,2)}</pre>;}

export function ModelDebug(){
  const [authenticated,setAuthenticated]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState('');
  const [traces,setTraces]=useState<TraceSummary[]>([]),[id,setId]=useState(new URLSearchParams(location.search).get('trace')??''),[events,setEvents]=useState<TraceEvent[]>([]);
  const [search,setSearch]=useState(''),[mode,setMode]=useState<'single'|'board4'|'board6'>('board4'),[format,setFormat]=useState<'prompt-json'|'json-schema'>('prompt-json');
  const [sending,setSending]=useState(false),[running,setRunning]=useState(false),[follow,setFollow]=useState(true),[pretty,setPretty]=useState(false),[copied,setCopied]=useState(''),[now,setNow]=useState(Date.now());
  const outputRef=useRef<HTMLPreElement>(null),copyTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const header=events.find(e=>e.type==='request'),config=events.find(e=>e.type==='prediction_started'),generation=events.find(e=>e.type==='generation_finished');
  const validation=events.find(e=>e.type==='validation'),failure=events.find(e=>e.type==='error'),terminal=!!(validation||failure);
  const selected=traces.find(t=>t.id===id),historical=!!header?.historical;
  const output=useMemo(()=>generation?.output??events.filter(e=>e.type==='fragment'&&e.reasoningType==='none').map(e=>e.content??'').join(''),[events,generation]);
  const reasoning=useMemo(()=>events.filter(e=>e.type==='fragment'&&e.reasoningType!=='none').map(e=>e.content??'').join(''),[events]);
  const renderedOutput=useMemo(()=>{if(pretty&&terminal)try{return JSON.stringify(JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1')),null,2);}catch{/* 原文仍完整保留 */}return output;},[pretty,terminal,output]);
  const itemEvents=events.filter(e=>e.type==='item_complete');
  const first=events.find(e=>e.type==='first_output'),firstToken=events.find(e=>e.type==='first_token'),prepared=events.find(e=>e.type==='images_prepared'),prediction=events.find(e=>e.type==='prediction_started');
  const wall=terminal?(generation??events.at(-1))?.elapsedMs:header?Math.max(events.at(-1)?.elapsedMs??0,now-header.at*1000+header.elapsedMs):null;
  const filtered=traces.filter(t=>(t.label+' '+t.model+' '+t.componentIds.join(' ')).toLowerCase().includes(search.trim().toLowerCase()));

  useEffect(()=>{const before=document.title;document.title='观微 · 模型调试';return()=>{document.title=before;};},[]);
  useEffect(()=>{let active=true;void request('/bootstrap').then(()=>{if(active)setAuthenticated(true);}).catch(e=>{if(active&&!(e instanceof ApiError&&e.status===401))setError((e as Error).message);}).finally(()=>{if(active)setReady(true);});return()=>{active=false;clearTimeout(copyTimer.current);};},[]);
  useEffect(()=>{
    if(!authenticated)return;let active=true;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const result=await request<{traces:TraceSummary[];running:boolean}>('/debug/traces');if(active){setTraces(result.traces);setRunning(result.running);setId(current=>current||result.traces[0]?.id||'');}}catch(e){if(active){setError((e as Error).message);if(e instanceof ApiError&&e.status===401)setAuthenticated(false);}}finally{if(active)timer=setTimeout(poll,1200);}};
    void poll();return()=>{active=false;clearTimeout(timer);};
  },[authenticated]);
  useEffect(()=>{
    if(!authenticated||!id)return;let active=true,last=0;let timer:ReturnType<typeof setTimeout>;
    setEvents([]);setPretty(false);
    const poll=async()=>{let done=false;try{const response=await request<{events:TraceEvent[];next:number}>('/debug/traces/'+id+'?after='+last);if(active){last=response.next;setEvents(old=>[...old,...response.events.filter(e=>e.seq>(old.at(-1)?.seq??0))]);done=response.events.some(e=>e.type==='validation'||e.type==='error');}}catch(e){if(active&&!(e instanceof ApiError&&e.status===404)){setError((e as Error).message);if(e instanceof ApiError&&e.status===401)setAuthenticated(false);}}finally{if(active&&!done)timer=setTimeout(poll,400);}};
    void poll();return()=>{active=false;clearTimeout(timer);};
  },[authenticated,id]);
  useEffect(()=>{if(!id||terminal||historical)return;const timer=setInterval(()=>setNow(Date.now()),250);return()=>clearInterval(timer);},[id,terminal,historical]);
  useEffect(()=>{if(follow&&outputRef.current)outputRef.current.scrollTop=outputRef.current.scrollHeight;},[renderedOutput,follow]);
  function select(value:string){setId(value);setEvents([]);const url=new URL(location.href);url.searchParams.set('trace',value);history.replaceState(null,'',url);}
  async function login(){setSending(true);try{await request('/session',{});setAuthenticated(true);setError('');}catch(e){setError((e as Error).message);}finally{setSending(false);}}
  async function start(){setSending(true);setError('');try{const result=await request<{id:string}>('/debug/samples',{mode,format});select(result.id);setRunning(true);}catch(e){setError((e as Error).message);}finally{setSending(false);}}
  async function copy(text:string,label:string){try{await navigator.clipboard.writeText(text);setCopied(label);clearTimeout(copyTimer.current);copyTimer.current=setTimeout(()=>setCopied(''),1500);}catch{setError('浏览器未允许复制，请在文本区域中选择内容复制。');}}
  function download(){const url=URL.createObjectURL(new Blob([JSON.stringify({traceId:id,events},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='model-trace-'+id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

  return <div className="md-page">
    <header className="md-header"><a href="/"><ArrowLeft size={18}/>检验工作台</a><strong>模型调试</strong><span className="md-local">本机</span><span className="md-live"><i/>每0.4秒更新当前调用</span></header>
    {!ready?<main className="md-empty">正在连接本机服务…</main>:!authenticated?<main className="md-empty"><Activity size={32}/><h1>查看模型的实际输入与输出</h1><p>使用本地试用会话进入。不会创建或提交检验任务。</p><button className="md-primary" disabled={sending} onClick={()=>void login()}>进入调试窗口</button>{error?<p role="alert">{error}</p>:null}</main>:<>
      <section className="md-controls"><div><h1>输入、生成与耗时</h1><p>检验调用自动留档；内置样例可以单独试跑。</p></div><div className="md-run-controls"><label>样例<select value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="single">单件（同源链路对照）</option><option value="board4">4件白板</option><option value="board6">6件白板</option></select></label><label>生成约束<select value={format} onChange={e=>setFormat(e.target.value as typeof format)}><option value="prompt-json">提示词 JSON（当前方式）</option><option value="json-schema">JSON Schema（试验）</option></select></label><button className="md-primary" disabled={sending||running} onClick={()=>void start()}><Play size={15}/>{sending?'正在发送':running?'模型调用中':'发送内置样例'}</button></div></section>
      {error?<div className="md-error" role="alert">{error}</div>:null}
      <div className="md-workspace"><aside className="md-history"><label className="md-search"><Search size={16}/><input aria-label="搜索调试记录" placeholder="搜索任务、模型或编号" value={search} onChange={e=>setSearch(e.target.value)}/></label><div className="md-history-heading">最近调用 <small>{traces.length}</small></div><div className="md-history-list">{filtered.map(t=><button key={t.id} className={'md-record '+(t.id===id?'selected':'')} onClick={()=>select(t.id)} aria-current={t.id===id?'true':undefined}><span className="md-record-title">{t.label}</span><span className={'md-status '+t.status}>{statusText[t.status]}</span><small>{t.componentIds.length}件{t.componentIds.length===1?' · '+t.componentIds[0].slice(0,12):''} · {seconds(t.elapsedMs)}{t.historical?' · 历史实验':''}</small></button>)}{!filtered.length?<p className="md-empty-list">还没有记录。发送一次内置样例，或在工作台开始检测。</p>:null}</div></aside>
        <main className="md-detail">{!id?<div className="md-empty"><h2>从一次模型调用开始</h2><p>选择左侧记录查看实际发送的图片与提示词。</p></div>:!header?<div className="md-empty" role="status">正在等待输入快照…</div>:<>
          <div className="md-call-title"><div><h2>{header.label??selected?.label??'元件比对'}</h2><p>{header.model} · {config?.responseFormat==='json-schema'?'生成时Schema约束':'提示词约束JSON'} · thinking {config?.enableThinking===false?'关闭':'未记录'}</p></div><button className="md-text-button" onClick={download}><Download size={16}/>导出记录</button></div>
          {historical?<p className="md-notice">历史实验：图片、提示词、原始输出和SDK统计可查；当时未记录逐token／逐件时间，下面不补造时序。列表时间为导入时间。</p>:null}
          <section className="md-timing" aria-label="模型分段耗时"><div className="md-section-title"><h3>时间线</h3><span>{terminal?'本次调用已结束':'实时观察'} · {seconds(wall)}</span></div>
            <ol className="md-stages"><li><span>输入快照</span><strong>0.00 s</strong></li><li><span>图片准备完成</span><strong>{seconds(prepared?.elapsedMs)}</strong></li><li><span>首token（SDK事件）</span><strong>{seconds(firstToken?.elapsedMs)}</strong></li><li><span>首段正文</span><strong>{seconds(first?.observedAtMs)}</strong></li><li><span>生成结束</span><strong>{seconds(generation?.elapsedMs)}</strong></li><li><span>整批校验结束</span><strong>{seconds(validation?.elapsedMs)}</strong></li></ol>
            <div className="md-sdk-stats"><span>SDK首token等待 <b>{seconds(generation?.stats?.timeToFirstTokenSec==null?null:generation.stats.timeToFirstTokenSec*1000)}</b></span><span>输出 <b>{generation?.stats?.predictedTokensCount??'…'} tokens</b></span><span>生成速度 <b>{generation?.stats?.tokensPerSecond?.toFixed(1)??'…'} token/s</b></span><span>推理token <b>{generation?.reasoningTokens??'未完成'}</b></span></div>
            {!historical?<div className="md-item-table"><table><thead><tr><th>输出顺序／元件</th><th>从输入起</th><th>从首段正文起</th><th>本件输出区间</th></tr></thead><tbody>{itemEvents.map((e,index)=><tr key={e.seq}><td>{index+1}. <code>{e.componentId}</code></td><td>{seconds(e.observedAtMs)}</td><td>{seconds(e.sinceOutputMs)}</td><td>{seconds(e.sincePreviousItemMs)}</td></tr>)}{!itemEvents.length?<tr><td colSpan={4}>等待元件JSON完整输出…</td></tr>:null}</tbody></table><small>记录完整对象到达客户端的时刻；多个对象若在同一片段到达，可具有相同时间。分项输出期间仍待整批校验。</small></div>:null}
          </section>
          <div className="md-evidence"><section className="md-input"><div className="md-section-title"><h3>实际输入</h3><span>{header.images?.length??0}张图片</span></div><div className="md-images">{header.images?.map((image,index)=><figure key={image.index}><a href={`/api/debug/traces/${id}/images/${image.index}.png`} target="_blank" rel="noreferrer"><img src={`/api/debug/traces/${id}/images/${image.index}.png`} alt={index===0?'实际发送的正品图片':'实际发送的待检图片或白板'}/></a><figcaption><strong>{index===0?'01 正品标准':'02 待检输入'}</strong><span>{image.width} × {image.height} · {(image.bytes/1024).toFixed(0)} KB</span><details><summary>SHA256</summary><code>{image.sha256}</code></details></figcaption></figure>)}</div>
            <div className="md-section-title md-prompt-title"><h3>完整提示词</h3><button className="md-text-button" onClick={()=>void copy(header.messages?.flatMap(m=>m.content.filter(b=>b.type==='text').map(b=>b.text)).join('\n')??'','prompt')}><Copy size={14}/>{copied==='prompt'?'已复制':'复制'}</button></div>{header.messages?.map((message,i)=><div key={i}><small>{message.role}</small><pre className="md-prompt">{message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')}</pre></div>)}
            <details className="md-config"><summary>请求参数、消息顺序与Schema <ChevronRight size={15}/></summary><JsonBlock value={{messages:header.messages,config:prediction,images:header.images}}/></details>
          </section><section className="md-output"><div className="md-section-title"><h3>模型原始输出</h3><button className="md-text-button" disabled={!output} onClick={()=>void copy(output,'output')}><Copy size={14}/>{copied==='output'?'已复制':'复制'}</button></div><div className="md-output-options"><label><input type="checkbox" checked={follow} onChange={e=>setFollow(e.target.checked)}/>跟随输出</label><label><input type="checkbox" checked={pretty} disabled={!terminal} onChange={e=>setPretty(e.target.checked)}/>格式化显示</label></div><pre ref={outputRef} className="md-stream" aria-label="模型流式原文">{renderedOutput||'等待模型输出正文…'}</pre>
            <p className={'md-result '+(failure?'error':validation?.valid?'valid':validation?'invalid':'running')} role="status">{failure?.message??validation?.message??(generation?'生成结束，等待整批校验…':'正在生成，尚未形成有效检测结果。')}</p>
            <details className="md-config"><summary>推理通道（{generation?.reasoningTokens??0} tokens）<ChevronRight size={15}/></summary><pre className="md-json">{reasoning||'本次未观察到推理文本。'}</pre></details>
            <details className="md-config"><summary>SDK原始统计与事件记录 <ChevronRight size={15}/></summary><JsonBlock value={{stats:generation?.stats,events:events.filter(e=>e.type!=='fragment')}}/></details>
          </section></div>
          <p className="md-footnote">时间从输入快照开始，含本地图片准备、上传与推理；不含之前的拍照及定位裁剪。首token前无法仅凭本日志再细分模型内部视觉编码与预填充。逐件时间是JSON对象到达时间，不是各元件的独立视觉计算时间。Schema约束结构，不保证读字或判定正确。</p>
        </>}</main></div>
    </>}
  </div>;
}

import { useEffect,useState } from 'react';
import { ArrowLeft,Download,Play,ScanLine } from 'lucide-react';
import { ApiError,request } from './api';
import { Btn,Spinner } from './ui';
import { apiPath,markingPaths } from '../../shared/paths';
import type { StarterOptions,StarterRun } from '../../server/vision/starter';
import './vision-starter.css';
const defaults:StarterOptions={separate:false,backend:'vlm',reference:'clear'};
const image=(id:string)=>apiPath('/debug/vision-starter/assets/'+id);
const backendName={vlm:'现有 VLM',lightweight:'轻量 OCR',auto:'按正品分析推荐'};
export function VisionStarter(){
 const [options,setOptions]=useState(defaults),[result,setResult]=useState<StarterRun|null>(null),[ready,setReady]=useState(false),[auth,setAuth]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let active=true;request('/debug/vision-starter').then(()=>{if(active)setAuth(true);}).catch(e=>{if(active&&(!(e instanceof ApiError)||e.status!==401))setError(e.message);}).finally(()=>{if(active)setReady(true);});return()=>{active=false;};},[]);
 function change(patch:Partial<StarterOptions>){setOptions(v=>({...v,...patch}));setResult(null);setError('');}
 async function login(){setBusy(true);setError('');try{await request('/session',{});await request('/debug/vision-starter');setAuth(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function run(){setBusy(true);setError('');setResult(null);try{setResult(await request<StarterRun>('/debug/vision-starter',options));}catch(e){if(e instanceof ApiError&&e.status===401)setAuth(false);setError((e as Error).message);}finally{setBusy(false);}}
 function download(){if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='vision-starter-mock.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 const incompatible=options.backend==='lightweight'&&!options.separate;
 return <div className="vs-page"><header className="vs-top"><a href={markingPaths.workbench}><ArrowLeft size={18}/>检验工作台</a><strong>鉴微 <span>算法接入</span></strong><span className="vs-tag">本机联调 · 模拟</span></header><main className="vs-main">
  <div className="vs-heading"><div><h1>把两条通路先接起来</h1><p>前置分割与识别后端独立选择，查看同一张样图如何流转。</p></div><Btn disabled={!result||busy} onClick={download}><Download size={16}/>导出输入与输出</Btn></div>
  <p className="vs-notice">仅模拟：固定人工选框与预设读文，不运行 CV、OCR 或 VLM，不写入检验记录和 MES。</p>
  {!ready?<p role="status">正在连接本机联调接口…</p>:!auth?<section className="vs-access"><h2>进入本机联调</h2><p>使用本地试用会话，只能直接在运行服务的电脑上访问。</p><Btn tone="primary" disabled={busy||!!error} onClick={()=>void login()}>进入联调页</Btn></section>:<>
   <section className="vs-controls" aria-label="识别通路设置"><label className="vs-switch"><input type="checkbox" role="switch" checked={options.separate} disabled={busy} onChange={e=>change({separate:e.target.checked})}/><span><strong>前置定位分割</strong><small>{options.separate?'启用固定选框模拟，生成完整元件裁片':'关闭，直接使用完整原图'}</small></span></label><label>识别后端<select aria-label="识别后端" disabled={busy} value={options.backend} onChange={e=>change({backend:e.target.value as StarterOptions['backend']})}><option value="vlm">现有 VLM（模拟）</option><option value="lightweight">轻量 OCR（模拟）</option><option value="auto">按正品分析推荐（模拟）</option></select></label><label>正品分析参考<select aria-label="正品分析参考" disabled={busy} value={options.reference} onChange={e=>change({reference:e.target.value as StarterOptions['reference']})}><option value="clear">清晰、无歧义</option><option value="ambiguous">存在字形歧义</option><option value="low-confidence">识别把握较低</option><option value="unknown">缺少分析信息</option></select></label><Btn tone="primary" disabled={busy||incompatible} onClick={()=>void run()}>{busy?<Spinner/>:<Play size={17}/>} {busy?'正在校验接口…':'运行模拟通路'}</Btn></section>
   {incompatible?<p className="vs-warning" role="status">这个轻量 OCR 示例只接受单件裁片。请开启分割或选择 VLM；系统不会暗中替你开启前置步骤。</p>:null}
   <ol className="vs-flow" aria-label="本次通路"><li>01 原始照片</li><li>{options.separate?'02 模拟定位 → 裁片':'02 跳过前置分割'}</li><li>03 {result?backendName[result.route.selected]:backendName[options.backend]}{result?' · 模拟完成':''}</li></ol>
   <div className="vs-workspace"><section className="vs-photo"><h2><ScanLine size={19}/>待检样图 <small>生成样片 · 1536 × 1024</small></h2><div className="vs-original"><img src={image('original')} width="1536" height="1024" alt="绿色防静电垫上两个元件，左侧SV358，右侧SV385"/>{result?.separation?<svg viewBox="0 0 1536 1024" role="img" aria-label="模拟分割位置">{result.separation.components.map((c,i)=><g key={c.componentId}><polygon points={c.quadPx.map(p=>p.join(',')).join(' ')}/><text x={c.quadPx[0][0]} y={c.quadPx[0][1]-16}>C0{i+1}</text></g>)}</svg>:null}</div><p>正品比对文字：SV358 / A26 / 0147。右侧元件型号为 SV385，用于演示错字及编号对应。</p></section>
    <section className="vs-output" aria-label="模拟输出"><h2>{result?'本次模拟输出':'运行后查看结果'}</h2>{!result?<div className="vs-empty"><ScanLine size={30}/><p>选择通路后点击运行。</p><small>图片和 JSON 在同一组元件 ID 下对应，不生成真实检测结论。</small></div>:<><div className="vs-route"><strong>{backendName[result.route.selected]} · 模拟</strong><p>{result.route.reasons.join(' ')}</p><small>{result.options.backend==='auto'?'路由依据：质量、字形歧义及 VLM 自评，阈值 0.9 仅供试验，未作准确率标定。':'手动指定后端，不使用推荐阈值改变选择。'}</small></div><div className="vs-items">{result.reply.items.map((item,i)=><article key={item.componentId}>{result.separation?<img src={image('crop-'+(i+1))} alt={'C0'+(i+1)+' 模拟裁片'}/>:null}<div><header><strong>C0{i+1}</strong><span className={item.verdict==='PASS'?'vs-pass':'vs-fail'}>{item.verdict==='PASS'?'预设合格':'预设不合格'}</span></header><pre>{item.lines.join('\n')}</pre><small>{item.componentId}</small></div></article>)}</div><p className="vs-footnote">接口校验共 {result.elapsedMs} ms，不是模型推理耗时。模拟结果不进入业务计数。</p></> }</section></div>
   {result?<details className="vs-json"><summary>查看输入、分割、OCR 与模拟比对 JSON</summary><pre>{JSON.stringify(result,null,2)}</pre></details>:null}
  </>}
  {error?<p className="vs-error" role="alert">{error}{error.includes('本机')?' HTTPS转发不属于直接访问。请用 http://127.0.0.1:5190/inspections/marking/debug/vision-starter，非默认端口按实际配置填写。':''}</p>:null}
  <footer className="vs-footer">算法同事先替换 MockSeparator / MockOcr，确认合同与样图，再接真实模型。生产通路开关尚未启用。</footer>
 </main></div>;
}

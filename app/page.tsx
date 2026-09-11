"use client";

import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import { ScanLine, Scan, Layers2, ClipboardList, ChevronRight, Plus, ArrowUpRight, Upload, Camera, CircleHelp, ShieldCheck, ImagePlus, Columns2, Blend, Focus, Check, ZoomIn, ZoomOut, RotateCcw, Maximize2, CircleAlert, ArrowRight, FileText, Grid2X2, X, Smartphone, CheckCheck, ImageIcon, Download, MoveHorizontal, Eye, MousePointer2, Lightbulb, LocateFixed, Info, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarInset } from "@/components/ui/sidebar";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Toaster, toast } from "sonner";
import { flushSync } from "react-dom";

const REFERENCE = "/images/reference.png";
const INSPECTION = "/images/inspection.png";
type Sample = { id:string; src:string; name:string; status:"normal"|"review"|"blur"|"pending"; demo:boolean };
type Review = { id:string; sampleId:string; batch:string; result:string; note:string; time:string; demo:boolean };
type View = "inspect"|"references"|"records";
type Panel = "new"|"review"|"help"|"reference"|null;
const NAV = [{id:"inspect" as View,label:"来料对比",icon:Scan},{id:"references" as View,label:"正品参考",icon:Layers2},{id:"records" as View,label:"复核记录",icon:ClipboardList}];
const DEMO: Sample[] = ["A01","A02","A03","A04","A05","A06"].map((id,i)=>({id,src:i===2||i===4?INSPECTION:REFERENCE,name:`演示器件 ${id}`,status:i===2||i===4?"review":i===5?"blur":"normal",demo:true}));
const STATUS = {normal:"未见异常",review:"待复核",blur:"需补拍",pending:"待分析"};
const MARKS = [{id:1,label:"丝印内容",x:39.5,y:47.5,w:20,h:10.5},{id:2,label:"表面纹理",x:68.5,y:16.5,w:7,h:9}];
const RESULT_OPTIONS = ["需进一步复核","差异可接受","需要补拍"];

function Photo({src,alt,zoom=1,focus=0,annotations=false,blur=false,onMark,showAll=false,onInspect,pan={x:0,y:0},onPan}:{src:string;alt:string;zoom?:number;focus?:number;annotations?:boolean;blur?:boolean;onMark?:(id:number)=>void;showAll?:boolean;onInspect?:()=>void;pan?:{x:number;y:number};onPan?:(pan:{x:number;y:number})=>void}) {
 const drag=useRef<{x:number;y:number;px:number;py:number}|null>(null);
 const m=MARKS.find(v=>v.id===focus);
 return <div className={`photo-stage ${blur?"is-blurred":""}`} onDoubleClick={onInspect} style={{touchAction:zoom>1?"none":"pan-y",cursor:zoom>1?"grab":"default"}}
 onPointerDown={e=>{if(zoom<=1||(e.target as HTMLElement).closest("button"))return;e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y}}}
 onPointerMove={e=>{if(!drag.current)return;const rect=e.currentTarget.getBoundingClientRect();onPan?.({x:Math.max(-90,Math.min(90,drag.current.px+(e.clientX-drag.current.x)/rect.width*100)),y:Math.max(-90,Math.min(90,drag.current.py+(e.clientY-drag.current.y)/rect.height*100))})}}
 onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}}>
   <div className="photo-transform" style={{transform:`translate(${pan.x}%, ${pan.y}%) scale(${zoom})`,transformOrigin:m?`${m.x+m.w/2}% ${m.y+m.h/2}%`:"50% 50%"}}>
    <img src={src} alt={alt} className="component-photo" draggable={false}/>
    {annotations&&MARKS.filter(v=>showAll||v.id===focus).map(mark=><button key={mark.id} className={`annotation ${focus===mark.id?"active":""}`} style={{left:`${mark.x}%`,top:`${mark.y}%`,width:`${mark.w}%`,height:`${mark.h}%`}} aria-label={`查看差异 ${mark.id}：${mark.label}`} onClick={()=>onMark?.(mark.id)}><span>{String(mark.id).padStart(2,"0")}</span></button>)}
   </div>
   <span className="stage-corner corner-tl"/><span className="stage-corner corner-br"/>
   {blur&&<span className="photo-quality"><CircleAlert size={13}/>丝印不清晰</span>}
 </div>
}

export default function Home() {
 const [view,setView]=useState<View>("inspect");
 const [mode,setMode]=useState("side");
 const [samples,setSamples]=useState<Sample[]>(DEMO);
 const [selected,setSelected]=useState("A03");
 const [reference,setReference]=useState(REFERENCE);
 const [referenceName,setReferenceName]=useState("NX32F407VGT6");
 const [batch,setBatch]=useState("IN-0926");
 const [focus,setFocus]=useState(1);
 const [zoom,setZoom]=useState(1);
 const [pan,setPan]=useState({x:0,y:0});
 const [marks,setMarks]=useState(true);
 const [wipe,setWipe]=useState(50);
 const [mobilePhoto,setMobilePhoto]=useState("sample");
 const [panel,setPanel]=useState<Panel>(null);
 const lastPanel=useRef<Panel>(null);if(panel)lastPanel.current=panel;const panelContent=panel??lastPanel.current;
 const [expanded,setExpanded]=useState(false);
 const [reviews,setReviews]=useState<Review[]>([]);
 const [reviewResult,setReviewResult]=useState(RESULT_OPTIONS[0]);
 const [reviewNote,setReviewNote]=useState("");
 const [draftName,setDraftName]=useState("");
 const [draftBatch,setDraftBatch]=useState("");
 const [draftRef,setDraftRef]=useState("");
 const [draftRefName,setDraftRefName]=useState("");
 const [draftSamples,setDraftSamples]=useState<{src:string;name:string}[]>([]);
 const [busy,setBusy]=useState(false);
 const [progress,setProgress]=useState(0);
 const [error,setError]=useState("");
 const targetInput=useRef<HTMLInputElement>(null);
 const referenceInput=useRef<HTMLInputElement>(null);
 const cameraInput=useRef<HTMLInputElement>(null);
 const draftInput=useRef<HTMLInputElement>(null);
 const draftReferenceInput=useRef<HTMLInputElement>(null);
 const urls=useRef<string[]>([]);
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const sample=samples.find(v=>v.id===selected)??samples[0];
 const isDemo=sample.demo&&reference===REFERENCE;
 const hasFindings=isDemo&&sample.status==="review";
 const needsRetake=isDemo&&sample.status==="blur";
 const normal=isDemo&&sample.status==="normal";
 const currentReview=reviews.find(r=>r.sampleId===sample.id&&r.batch===batch);
 const pendingCount=samples.filter(s=>s.status==="review"&&!reviews.some(r=>r.sampleId===s.id&&r.batch===batch)).length;
 const reviewRef=useRef({samples,selected,view,reviews,batch});
 reviewRef.current={samples,selected,view,reviews,batch};
 useEffect(()=>()=>{urls.current.forEach(URL.revokeObjectURL);if(timer.current)clearTimeout(timer.current);},[]);
 useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.key==="Escape")setExpanded(false);};window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);},[]);
 useEffect(()=>{
  const context=(document as Document&{modelContext?:{registerTool:(tool:unknown,options?:unknown)=>void|Promise<void>}}).modelContext;
  if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  const tools=[{name:"get_inspection_state",title:"读取当前对比",description:"读取本次会话中的器件、选中项与复核数量。演示结果不是模型检测。",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:()=>({selected:reviewRef.current.selected,view:reviewRef.current.view,batch:reviewRef.current.batch,samples:reviewRef.current.samples.map(({id,status,demo})=>({id,status,demo})),reviewCount:reviewRef.current.reviews.length})},
  {name:"select_inspection_sample",title:"查看待检器件",description:"切换当前查看的器件，不产生检测或复核结论。",inputSchema:{type:"object",properties:{sampleId:{type:"string"}},required:["sampleId"],additionalProperties:false},annotations:{readOnlyHint:false},execute:(input:unknown)=>{const id=(input as {sampleId?:unknown})?.sampleId;if(typeof id!=="string"||!reviewRef.current.samples.some(s=>s.id===id))throw new Error("器件编号不存在");flushSync(()=>{setSelected(id);setView("inspect");setZoom(1);setFocus(1);setMode("side")});return{selected:id,view:"inspect"};}}];
  for(const tool of tools){try{Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
  return()=>lifecycle.abort();
 },[]);
 function navigate(next:View){setView(next);window.scrollTo({top:0,behavior:"instant"});}
 function selectSample(id:string){setPan({x:0,y:0});setSelected(id);setZoom(1);setFocus(1);setMode("side");setMobilePhoto("sample");}
 function selectFinding(id:number){setPan({x:0,y:0});setFocus(id);setMode("detail");setZoom(id===1?2.6:3.8);setMobilePhoto("sample");if(window.innerWidth<1001)document.querySelector(".comparison-panel")?.scrollIntoView({block:"start",behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"});}
 function changeMode(next:string){setPan({x:0,y:0});setMode(next);setZoom(next==="detail"?2.6:1);if(!hasFindings)setFocus(0);}
 function resetView(){setPan({x:0,y:0});setZoom(1);setFocus(1);setMode("side");setWipe(50);}
 async function readFiles(files:FileList|null){
  if(!files?.length)return[];
  const valid:{src:string;name:string}[]=[];
  for(const file of Array.from(files)){
   if(!["image/jpeg","image/png","image/webp"].includes(file.type)){toast.error(`${file.name}：请选择 JPG、PNG 或 WebP 图片`);continue;}
   if(file.size>20*1024*1024){toast.error(`${file.name} 超过 20 MB，请选择较小的原图`);continue;}
   const src=URL.createObjectURL(file);
   try{await new Promise<void>((resolve,reject)=>{const img=new Image();img.onload=()=>img.naturalWidth>0?resolve():reject();img.onerror=reject;img.src=src;});urls.current.push(src);valid.push({src,name:file.name});}catch{URL.revokeObjectURL(src);toast.error(`${file.name} 无法读取，请换一张图片`);}
  }
  return valid;
 }
 async function addImages(e:ChangeEvent<HTMLInputElement>,retake=false){
  const files=await readFiles(e.target.files);e.target.value="";if(!files.length)return;
  if(retake){setSamples(prev=>prev.map(s=>s.id===sample.id?{...s,src:files[0].src,name:files[0].name,status:"pending",demo:false}:s));setReviews(prev=>prev.filter(r=>!(r.sampleId===sample.id&&r.batch===batch)));}
  else {const additions:Sample[]=files.map((f,i)=>({...f,id:`A${String(samples.length+i+1).padStart(2,"0")}`,status:"pending",demo:false}));setSamples(prev=>[...prev,...additions]);setSelected(additions[0].id);}
  setZoom(1);setMode("side");setFocus(0);toast.success(retake?"补拍照片已替换，本次图片待分析":"照片已添加，可放大对照查看");
 }
 async function replaceReference(e:ChangeEvent<HTMLInputElement>){const files=await readFiles(e.target.files);e.target.value="";if(!files.length)return;setReference(files[0].src);setSamples(prev=>prev.map(s=>({...s,status:"pending"})));setReviews([]);resetView();toast.success("参考图已替换，旧对比结果已清除");}
 async function draftFiles(e:ChangeEvent<HTMLInputElement>,isRef=false){const files=await readFiles(e.target.files);e.target.value="";if(!files.length)return;if(isRef){setDraftRef(files[0].src);setDraftRefName(files[0].name);}else setDraftSamples(prev=>[...prev,...files].slice(0,24));setError("");}
 function startNew(){setDraftName("");setDraftBatch("");setDraftRef("");setDraftRefName("");setDraftSamples([]);setError("");setPanel("new");}
 function createComparison(){
  if(!draftName.trim()){setError("请填写物料名称，方便识别这次对比。");return;}
  if(!draftSamples.length){setError("请至少添加一张待检照片。");return;}
  setBusy(true);setProgress(35);
  timer.current=setTimeout(()=>{const added:Sample[]=draftSamples.map((f,i)=>({...f,id:`A${String(i+1).padStart(2,"0")}`,status:"pending",demo:false}));setSamples(added);setSelected("A01");setPan({x:0,y:0});setReference(draftRef||reference);setReferenceName(draftName.trim());setBatch(draftBatch.trim()||`LOCAL-${String(Date.now()).slice(-6)}`);setFocus(0);setZoom(1);setMode("side");setView("inspect");setProgress(100);setBusy(false);setPanel(null);toast.success("对比已建立，图片仅保留在本次会话");window.scrollTo({top:0,behavior:"instant"});},650);
 }
 function resetDemo(){setReviews(prev=>prev.filter(r=>r.batch!=="IN-0926"));setSamples(DEMO);setSelected("A03");setReference(REFERENCE);setReferenceName("NX32F407VGT6");setBatch("IN-0926");resetView();setPanel(null);navigate("inspect");toast("已切换到演示样本");}
 function openReview(){setReviewResult(currentReview?.result??(needsRetake?"需要补拍":RESULT_OPTIONS[0]));setReviewNote(currentReview?.note??"");setPanel("review");}
 function saveReview(){const record:Review={id:crypto.randomUUID(),sampleId:sample.id,batch,result:reviewResult,note:reviewNote.trim(),time:new Date().toLocaleString("zh-CN",{hour12:false}),demo:isDemo};setReviews(prev=>[record,...prev.filter(r=>!(r.sampleId===sample.id&&r.batch===batch))]);setPanel(null);toast.success(`${sample.id} 复核已记录`,{description:"保留在本次会话，可在「复核记录」中导出。"});}
 function exportRecords(){const content=JSON.stringify({title:"观微复核记录",scope:"人工记录；演示数据已标明；不代表真伪鉴定",records:reviews},null,2);const url=URL.createObjectURL(new Blob([content],{type:"application/json;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download="观微-复核记录.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast.success("复核记录已导出");}
 const labels={inspect:"来料对比",references:"正品参考",records:"复核记录"};
 const imageProps={zoom,pan,onPan:setPan,focus:mode==="detail"?focus:0};
 const renderComparison=(scope="main")=> <>
  <div className="comparison-toolbar"><Tabs value={mode} onValueChange={changeMode}><TabsList className="compare-tabs"><TabsTrigger value="side"><Columns2/><span className="desktop-compare-label">并排对比</span><span className="mobile-compare-label">切换对比</span></TabsTrigger><TabsTrigger value="wipe"><Blend/>滑动对比</TabsTrigger><TabsTrigger value="detail"><Focus/>局部细看</TabsTrigger></TabsList></Tabs><label className="toolbar-note" htmlFor={`${scope}-show-marks`}><Switch id={`${scope}-show-marks`} checked={marks} onCheckedChange={setMarks} disabled={!hasFindings}/>差异标记</label></div>
  {mode==="wipe"?<div className="wipe-view"><div className="wipe-labels"><span><ShieldCheck size={14}/>正品参考</span><span>待检 · {sample.id}<Scan size={14}/></span></div><div className="wipe-stage" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);const r=e.currentTarget.getBoundingClientRect();setWipe(Math.max(0,Math.min(100,(e.clientX-r.left)/r.width*100)))}} onPointerMove={e=>{if(!e.currentTarget.hasPointerCapture(e.pointerId))return;const r=e.currentTarget.getBoundingClientRect();setWipe(Math.max(0,Math.min(100,(e.clientX-r.left)/r.width*100)))}} onPointerUp={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}}><img src={sample.src} alt={`待检器件 ${sample.id}`} className={needsRetake?"blur-image":""}/><img src={reference} alt="正品参考" style={{clipPath:`inset(0 ${100-wipe}% 0 0)`}}/><div className="wipe-line" style={{left:`${wipe}%`}}><span><MoveHorizontal size={19}/></span></div></div><div className="wipe-slider"><span>参考图</span><Slider value={[wipe]} onValueChange={v=>setWipe(v[0])} min={0} max={100} step={1} aria-label="滑动比较参考图和待检图"/><span>待检图</span></div></div>:<>
  <div className="mobile-image-toggle"><Tabs value={mobilePhoto} onValueChange={setMobilePhoto}><TabsList><TabsTrigger value="sample">待检 · {sample.id}</TabsTrigger><TabsTrigger value="reference"><ShieldCheck size={13}/>正品参考</TabsTrigger></TabsList></Tabs><span>{mode==="detail"?"同步放大":"切换对照"}</span></div>
  <div className={`image-pair ${mode==="detail"?"detail-mode":""}`}>
   <div className={`image-pane reference-pane ${mobilePhoto==="reference"?"mobile-visible":""}`}><div className="image-pane-label"><span className="reference-symbol"><ShieldCheck size={15}/></span><strong>正品参考</strong><button className="mini-badge change-photo" onClick={()=>referenceInput.current?.click()}>更换<ChevronRight size={11}/></button></div><Photo src={reference} alt="正品参考元件顶面" {...imageProps} annotations={hasFindings&&marks} focus={focus} showAll={mode!=="detail"} onMark={selectFinding} onInspect={()=>{setExpanded(true);setZoom(2);}}/><div className="image-caption"><span>REF-001 · 顶面</span><span>原始图像</span></div></div>
   <div className={`image-pane sample-pane ${mobilePhoto==="sample"?"mobile-visible":""}`}><div className="image-pane-label"><span className="sample-symbol"><Scan size={15}/></span><strong>待检器件 · {sample.id}</strong><span className={`mini-badge ${hasFindings?"amber-badge":""}`}>{currentReview?"已复核":STATUS[sample.status]}</span></div><Photo src={sample.src} alt={`待检器件 ${sample.id} 顶面`} {...imageProps} annotations={hasFindings&&marks} focus={focus} blur={needsRetake} showAll={mode!=="detail"} onMark={selectFinding} onInspect={()=>{setExpanded(true);setZoom(2);}}/><div className="image-caption"><span>{sample.id} · 顶面</span><span>{sample.demo?"演示图像":"本次上传"}</span></div></div>
  </div></>}
  <div className="zoom-toolbar"><span>{mode==="detail"&&hasFindings?`局部 ${String(focus).padStart(2,"0")} · ${focus===1?"第三行丝印":"右上方表面"}`:zoom>1?"拖动图片，两图同步移动":"两张图片同步缩放"}</span><div><Button variant="ghost" size="icon" aria-label="缩小" disabled={zoom<=1||mode==="wipe"} onClick={()=>setZoom(z=>Math.max(1,z-.5))}><ZoomOut/></Button><span aria-live="polite">{Math.round(zoom*100)}%</span><Button variant="ghost" size="icon" aria-label="放大" disabled={zoom>=5||mode==="wipe"} onClick={()=>setZoom(z=>Math.min(5,z+.5))}><ZoomIn/></Button><i/><Button variant="ghost" size="icon" aria-label="重置视图" onClick={resetView}><RotateCcw/></Button><Button variant="ghost" size="icon" aria-label={expanded?"退出大图":"大图对照"} onClick={()=>setExpanded(v=>!v)}>{expanded?<X/>:<Maximize2/>}</Button></div></div>
 </>;
 return <SidebarProvider style={{"--sidebar-width":"216px"} as CSSProperties}>
  <Toaster position="top-center" richColors closeButton/>
  <input ref={targetInput} type="file" hidden accept="image/jpeg,image/png,image/webp" multiple onChange={e=>void addImages(e)}/><input ref={referenceInput} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={e=>void replaceReference(e)}/><input ref={cameraInput} type="file" hidden accept="image/jpeg,image/png,image/webp" capture="environment" onChange={e=>void addImages(e,true)}/>
  <Sidebar className="app-sidebar"><SidebarHeader className="brand"><span className="brand-symbol"><ScanLine size={23}/></span><span><strong>观微<span className="brand-period">.</span></strong><small>SmartVerifier</small></span></SidebarHeader><SidebarContent><div className="workspace-label">物料检验工作台</div><SidebarMenu>{NAV.map(({id,label,icon:Icon})=><SidebarMenuItem key={id}><SidebarMenuButton className="nav-item" isActive={view===id} onClick={()=>navigate(id)}><Icon size={19}/><span>{label}</span>{id==="inspect"?<span className="nav-count">{samples.length}</span>:id==="records"&&reviews.length>0?<span className="nav-count">{reviews.length}</span>:null}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu><div className="sidebar-session"><span className="eyebrow">当前对比</span><div className="session-line"><div className="session-mark"><Grid2X2 size={16}/></div><div><strong title={referenceName}>{referenceName}</strong><small>来料批次 · {batch}</small></div></div><div className="session-progress"><span style={{width:`${((samples.length-pendingCount)/samples.length)*100}%`}}/></div><p>{isDemo?"待复核":"已添加"} <b>{isDemo?pendingCount:samples.length}</b> <span>共 {samples.length} 张器件图</span></p></div></SidebarContent><SidebarFooter><div className="sidebar-note"><ShieldCheck size={19}/><span>每一处差异，都有迹可循<small>基于参考图的外观对比</small></span></div><div className="profile"><span className="avatar"><ScanLine size={17}/></span><div><strong>检验工作空间</strong><small>交互原型 · 本次会话</small></div></div></SidebarFooter></Sidebar>
  <SidebarInset className="main-shell"><header className="topbar"><div className="breadcrumbs"><span className="desktop-breadcrumb">检验工作台</span><span className="mobile-brand"><ScanLine size={20}/>观微<span>.</span></span><ChevronRight size={14}/><strong>{labels[view]}</strong></div><div className="topbar-right"><span className="demo-badge">交互演示</span><a href="/mobile" className="desktop-only preview-link"><Smartphone size={14}/>手机预览</a><button className="help-trigger" aria-label="拍摄与操作指引" onClick={()=>setPanel("help")}><CircleHelp size={18}/></button></div></header>
  <main className="page-content"><div className="page-heading"><div><div className="eyebrow page-eyebrow">{view==="inspect"?"VISUAL INSPECTION":view==="references"?"REFERENCE LIBRARY":"REVIEW RECORDS"}</div><h1>{view==="inspect"?"让差异，一目了然":view==="references"?"每次对比，始于参照":"观察之后，留下依据"}<span className="title-dot">.</span></h1><p>{view==="inspect"?"以正品为参照，细看每一颗来料。":view==="references"?"保留原始细节，建立清晰的对比起点。":"汇集人工复核意见，便于下一步处理。"}</p></div>{view==="inspect"?<Button className="primary-button" onClick={startNew}><Plus/>新建对比</Button>:view==="references"?<Button className="primary-button" onClick={()=>referenceInput.current?.click()}><Upload/>更换参考图</Button>:<Button className="primary-button" disabled={!reviews.length} onClick={exportRecords}><Download/>导出记录</Button>}</div>
  {view==="inspect"?<>
  <div className="batch-bar"><div className="batch-identity"><span className="batch-icon"><Scan size={21}/></span><div><strong>{referenceName}</strong><span>{isDemo?"QFP 封装":"本次对比"} <i/> 批次 {batch}</span></div></div><div className="batch-facts"><span><Check size={14}/>参考图已就绪</span><span className="subtle">{samples.length} 张待检照片</span></div></div>
  {!isDemo&&<div className="local-notice" role="status"><Info size={17}/><div><strong>照片已准备好，可以手动对照</strong><span>此原型尚未接入检测模型。上传图片不会产生自动结论，仅在本次会话中查看。</span></div></div>}
  {isDemo&&<button className={`mobile-result-jump ${normal?"is-normal":""}`} onClick={()=>document.querySelector(".findings-panel")?.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth",block:"start"})}><span>{normal?<CheckCircle2 size={16}/>:needsRetake?<Camera size={16}/>:<ScanLine size={16}/>}<strong>{sample.id}</strong>{hasFindings?"发现 2 处差异":needsRetake?"图片不清晰，建议补拍":"未发现明显外观差异"}</span><span>查看<ChevronRight size={14}/></span></button>}
  <div className="inspection-layout"><section className="comparison-panel" aria-label="参考图与待检图对照">{renderComparison()}<div className="specimen-heading"><strong>待检器件 <span>{String(samples.length).padStart(2,"0")}</span></strong><span>点击切换，逐颗查看</span></div><div className="specimen-strip">{samples.map(s=><button className={`specimen ${s.id===sample.id?"selected":""}`} key={s.id} onClick={()=>selectSample(s.id)} aria-pressed={s.id===sample.id} aria-label={`查看器件 ${s.id}，${STATUS[s.status]}`}><span className="specimen-preview"><img src={s.src} alt="" className={s.status==="blur"?"blur-image":""}/>{reviews.some(r=>r.sampleId===s.id&&r.batch===batch)&&<span className="thumb-reviewed"><Check size={11}/></span>}</span><span><b>{s.id}</b><small className={s.status==="review"||s.status==="blur"?"text-warning":s.status==="pending"?"text-muted":"text-green"}>{STATUS[s.status]}</small></span></button>)}<button className="add-specimen" aria-label="添加待检照片" onClick={()=>targetInput.current?.click()}><Plus size={22}/><span>添加</span></button></div></section>
  <aside className="findings-panel"><div className="findings-title"><h2>差异观察</h2><span className="mini-badge">{isDemo?"演示结果":"待分析"}</span></div>
  <div className={`review-summary ${normal?"normal-summary":""} ${!isDemo?"pending-summary":""}`}><span className="summary-icon">{normal?<CheckCircle2 size={25}/>:needsRetake?<Camera size={25}/>:<ScanLine size={25}/>}</span><div><strong>{hasFindings?"有 2 处差异值得复核":needsRetake?"先补拍，再判断":normal?"未发现明显外观差异":"等待图像分析"}</strong><p>{hasFindings?"先看丝印，再确认表面细节。":needsRetake?"第三行丝印不清楚，暂不作判断。":normal?"本张演示器件与参考基本一致。":"图片已添加，当前可手动查看。"}</p></div></div>
  {hasFindings?<div className="findings-list"><button className={`finding ${focus===1?"selected":""}`} onClick={()=>selectFinding(1)}><span className="finding-number">01</span><div><div className="finding-header"><strong>丝印内容不同</strong><span className="severity">明显差异</span></div><p>第三行字符存在差异</p><div className="text-comparison"><span>参考 <b>VGT6</b></span><ArrowRight size={13}/><span>待检 <b>V6T6</b></span></div></div><ChevronRight size={15}/></button><button className={`finding ${focus===2?"selected":""}`} onClick={()=>selectFinding(2)}><span className="finding-number">02</span><div><div className="finding-header"><strong>表面纹理差异</strong><span className="severity mild">细微差异</span></div><p>右上方表面有局部擦痕</p></div><ChevronRight size={15}/></button></div>:needsRetake?<div className="retake-guidance"><h3>这样补拍更容易看清</h3><p><LocateFixed size={16}/>靠近器件，让文字占满画面</p><p><Lightbulb size={16}/>避开反光，轻点文字处对焦</p><p><Camera size={16}/>保持托盘位置，补拍 {sample.id}</p></div>:!isDemo?<div className="retake-guidance"><p><ZoomIn size={16}/>放大核对丝印内容</p><p><Blend size={16}/>滑动查看形状和图案</p><p><ClipboardList size={16}/>记录自己的观察与意见</p></div>:null}
  <div className="feature-overview"><h3>{hasFindings?"其他观察项":"观察项目"}</h3>{[...(!hasFindings?["丝印内容"]:[]),"器件形状","引脚布局","表面颜色","标识图案"].map(label=><div key={label}><span>{label}</span><span>{normal||hasFindings?<><Check size={14}/>基本一致</>:needsRetake?"待补拍":"待分析"}</span></div>)}</div>
  <div className="evidence-note"><CircleAlert size={15}/><p>外观差异供人工复核，不能单独作为真伪结论。</p></div>{currentReview&&<div className="reviewed-state"><CheckCheck size={16}/>已记录：{currentReview.result}</div>}<Button className="review-button" onClick={openReview}>{currentReview?"修改复核意见":"记录复核"}<ArrowUpRight size={17}/></Button><Button variant="outline" className="retake-button" onClick={()=>cameraInput.current?.click()}><Camera size={16}/>补拍局部照片</Button></aside></div>
  </>:view==="references"?<section className="reference-workspace"><div className="reference-image-area"><div className="image-pane-label"><ShieldCheck size={17}/><strong>当前参考图</strong><span className="mini-badge">{reference===REFERENCE?"虚构演示样本":"本次上传"}</span></div><Photo src={reference} alt="当前正品参考图"/><div className="reference-image-footer"><span>原图保留，不做生成式修复</span><Button variant="ghost" onClick={()=>referenceInput.current?.click()}><Upload size={15}/>更换照片</Button></div></div><div className="reference-details"><span className="eyebrow">REFERENCE / 001</span><h2>{referenceName}</h2><span className="reference-tag">{reference===REFERENCE?"NOVA · QFP 封装":"自定义参考图"}</span><div className="reference-description"><h3>对比时，关注这些细节</h3><dl><div><dt>丝印内容</dt><dd>{reference===REFERENCE?"NOVA / NX32F407 / VGT6 / 24W32":"以您上传图片中的实际文字为准"}</dd></div><div><dt>形状与结构</dt><dd>封装轮廓、引脚排列、定位标记</dd></div><div><dt>颜色与图案</dt><dd>表面色泽、纹理、标识的布局</dd></div></dl></div><div className="reference-info"><Info size={17}/><p>批次码、日期码可能正常变化。请结合实际情况复核，不直接视为异常。</p></div><Button className="primary-button" onClick={()=>navigate("inspect")}>用这张图对比<ArrowRight size={16}/></Button><p className="session-disclaimer">原型中的照片与修改仅保留在本次会话。</p></div></section>:<section className="records-workspace"><div className="records-toolbar"><strong>本次会话 <span>{reviews.length} 条记录</span></strong><span>关闭或刷新页面前，可导出留存</span></div>{reviews.length===0?<div className="records-empty"><div className="empty-illustration"><ClipboardList size={40}/></div><h2>每一次复核，都值得留存</h2><p>查看器件差异后，点击「记录复核」，<br/>你的观察和处理意见会汇集在这里。</p><Button onClick={()=>navigate("inspect")}>去查看差异<ArrowRight size={16}/></Button></div>:<div className="record-list">{reviews.map(r=><article className="record-row" key={r.id}><span className="record-icon"><FileText size={21}/></span><div className="record-main"><strong>{r.sampleId}<span>{r.batch}</span>{r.demo&&<span className="mini-badge">演示样本</span>}</strong><p>{r.note||"未填写补充说明"}</p><small>{r.time}</small></div><span className={`record-status ${r.result==="差异可接受"?"accepted":""}`}>{r.result}</span>{r.batch===batch&&<Button variant="ghost" size="icon" aria-label={`查看 ${r.sampleId} 的图片`} onClick={()=>{selectSample(r.sampleId);navigate("inspect")}}><ArrowUpRight size={17}/></Button>}</article>)}</div>}</section>}
  <footer className="page-footer"><span><ShieldCheck size={13}/>原图保留 · 差异可追溯</span><span>{isDemo?"演示素材与结果，仅用于体验交互":"图片在当前浏览器中查看，未上传至检测服务"}</span></footer></main>
  <nav className="mobile-nav" aria-label="主导航">{NAV.map(({id,label,icon:Icon})=><button className={view===id?"active":""} aria-current={view===id?"page":undefined} onClick={()=>navigate(id)} key={id}><Icon size={21}/>{label}</button>)}</nav></SidebarInset>
  <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="expanded-comparison" showCloseButton={false}><DialogDescription className="sr-only">两张图片同步缩放，可切换并排和滑动视图，按 Escape 关闭。</DialogDescription><div className="expanded-heading"><DialogTitle>大图对照 <span>{sample.id} · {referenceName}</span></DialogTitle><Button variant="outline" onClick={()=>setExpanded(false)}><X size={16}/>关闭</Button></div>{renderComparison("expanded")}</DialogContent></Dialog>
  <Sheet open={panel!==null} onOpenChange={open=>{if(!open&&!busy)setPanel(null)}}><SheetContent className="workflow-sheet" onInteractOutside={e=>{if(busy)e.preventDefault()}}><SheetHeader><span className="sheet-eyebrow">{panelContent==="new"?"NEW COMPARISON":panelContent==="review"?"REVIEW & RECORD":"INSPECTION GUIDE"}</span><SheetTitle>{panelContent==="new"?"开始一次新的对比":panelContent==="review"?`记录 ${sample.id} 的复核意见`:"拍清楚，才能看仔细"}</SheetTitle><SheetDescription>{panelContent==="new"?"先确定参考，再添加待检照片。":panelContent==="review"?"保留你的观察，给下一步处理留下依据。":"几个小调整，让手机照片更有用。"}</SheetDescription></SheetHeader>
  {panelContent==="new"?<div className="sheet-body"><div className="form-step"><span>01</span><h3>这次对比什么物料</h3></div><label className="form-label" htmlFor="material-name">物料名称或料号 <b>*</b></label><Input id="material-name" placeholder="例如：NX32F407VGT6" value={draftName} maxLength={80} onChange={e=>{setDraftName(e.target.value);setError("")}}/><label className="form-label" htmlFor="batch-number">来料批次 <small>选填</small></label><Input id="batch-number" placeholder="例如：IN-0927" value={draftBatch} maxLength={80} onChange={e=>setDraftBatch(e.target.value)}/><div className="form-step"><span>02</span><h3>选择正品参考图</h3></div><div className="draft-reference"><img src={draftRef||reference} alt="本次使用的参考图"/><div><strong>{draftRef?"新参考图":"使用当前参考图"}</strong><small>{draftRefName||referenceName}</small><Button variant="link" onClick={()=>draftReferenceInput.current?.click()}>选择其他照片<ChevronRight size={13}/></Button></div><ShieldCheck size={20}/></div><input ref={draftReferenceInput} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={e=>void draftFiles(e,true)}/><div className="form-step"><span>03</span><h3>添加待检照片</h3><small>最多 24 张</small></div><input ref={draftInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={e=>void draftFiles(e)}/><button className="upload-zone" onClick={()=>draftInput.current?.click()}><ImagePlus size={28}/><strong>点击选择照片</strong><span>支持 JPG、PNG、WebP，单张不超过 20 MB</span></button>{draftSamples.length>0&&<div className="draft-photos">{draftSamples.map((f,i)=><div key={f.src}><img src={f.src} alt={f.name}/><button aria-label={`移除待检照片 ${i+1}`} onClick={()=>setDraftSamples(prev=>prev.filter((_,j)=>j!==i))}><X size={12}/></button><span>{i+1}</span></div>)}</div>}<p className="form-hint"><Info size={14}/>照片仅在本次会话使用，不会上传至检测服务。</p>{error&&<p className="form-error" role="alert">{error}</p>}{busy&&<Progress value={progress} aria-label="正在准备图片"/>}<Button className="sheet-primary" onClick={createComparison} disabled={busy}>{busy?"正在准备图片…":"建立对比"}<ArrowRight size={16}/></Button><button className="text-link demo-reset" onClick={resetDemo}>先用演示样本体验</button></div>:panelContent==="review"?<div className="sheet-body"><div className="review-context"><img src={sample.src} alt={`器件 ${sample.id}`}/><div><strong>{sample.id} · {referenceName}</strong><p>{batch}</p><span>{isDemo?"演示样本 · 非真实检测结论":"自有图片 · 人工复核"}</span></div></div><label className="form-label">处理意见</label><RadioGroup value={reviewResult} onValueChange={setReviewResult} className="review-options">{RESULT_OPTIONS.map((label,i)=><label key={label} className={reviewResult===label?"chosen":""} htmlFor={`result-${i}`}><RadioGroupItem value={label} id={`result-${i}`}/><span><strong>{label}</strong><small>{i===0?"保留疑点，交由质量人员进一步确认":i===1?"人工确认属于可接受的外观差异":"现有图片不足以支持判断"}</small></span></label>)}</RadioGroup><label className="form-label" htmlFor="review-note">观察与说明 <small>选填</small></label><Textarea id="review-note" placeholder="例如：第三行 G / 6 字符有差异，建议核对物料资料后再处理。" value={reviewNote} maxLength={1000} onChange={e=>setReviewNote(e.target.value)} rows={5}/><p className="form-hint">这是一条人工复核记录，不会自动执行物料放行。</p><Button className="sheet-primary" onClick={saveReview}><Check size={17}/>保存复核意见</Button></div>:<div className="sheet-body"><div className="guide-item"><span><LocateFixed size={23}/></span><div><h3>让器件占满画面</h3><p>先拍整体定位，再靠近拍丝印。整盘字太小时，按区域分别拍摄。</p></div></div><div className="guide-item"><span><Lightbulb size={23}/></span><div><h3>避开反光，稳住手机</h3><p>使用均匀照明，轻点文字处对焦。模糊和过曝的笔画无法靠放大可靠恢复。</p></div></div><div className="guide-item"><span><Focus size={23}/></span><div><h3>点差异，两张图一起放大</h3><p>点击差异说明或图片标记，可查看同一位置。也可以滑动对照整体形状。</p></div></div><div className="guide-item"><span><ClipboardList size={23}/></span><div><h3>看完后，记录你的判断</h3><p>区分明显差异、细微差异和看不清。记录留在本次会话，可导出保存。</p></div></div><div className="guide-demo-note"><Info size={18}/><p>当前为交互原型。示例图片为合成素材，差异结果预先设定；您上传的照片不会被自动判定。</p></div><Button variant="outline" className="sheet-primary" onClick={resetDemo}>恢复演示样本<RotateCcw size={16}/></Button></div>}
  </SheetContent></Sheet>
 </SidebarProvider>
}

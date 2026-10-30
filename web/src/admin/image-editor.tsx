import { clientId } from '../../../shared/client-id';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Crop, Hand, RotateCcw, Scan, SquareDashed, Trash2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Btn, Spinner } from '../ui';
import { request } from '../api';
import { apiPath } from '../../../shared/paths';
import { imagePoint, normalizeAngle, rectBetween, rotatedSize, rotatePoint, zoomAt } from '../../../shared/image-editor';
import type { Point, Rect, View } from '../../../shared/image-editor';
import { previewTransform, regionsOverlap, transformRegions } from '../../../shared/reference-geometry';
import { RegionOverlay } from '../reference-image';
import type { ReferenceAsset, ReferenceEditResult, ReferenceRegion } from '../../../shared/admin';

type Tool='move'|'crop'|'ignore'|'focus';
export function ReferenceImageEditor({asset,regions=[],initialTool='move',onApply,onClose}:{asset:ReferenceAsset;regions?:ReferenceRegion[];initialTool?:Tool;onApply:(a:ReferenceAsset,r:ReferenceRegion[])=>void;onClose:()=>void}){
  const [current,setCurrent]=useState(asset),[marks,setMarks]=useState(regions),[tool,setTool]=useState<Tool>(initialTool),[angle,setAngle]=useState(0),[view,setView]=useState<View>({x:0,y:0,scale:1}),[crop,setCrop]=useState<Rect|null>(null),[drawing,setDrawing]=useState<Rect|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState('');
  const [canvasElement,setCanvasElement]=useState<HTMLDivElement|null>(null);
  const viewport=useRef<HTMLDivElement>(null),bindViewport=useCallback((node:HTMLDivElement|null)=>{viewport.current=node;setCanvasElement(node);},[]),drag=useRef<{start:Point;view:View;image:Point;tool:Tool}|null>(null);
  const size=rotatedSize(current.width,current.height,angle),hasTransform=!!angle||!!crop;
  function fit(){const box=viewport.current?.getBoundingClientRect();if(box)setView({x:0,y:0,scale:Math.min((box.width-48)/size.width,(box.height-48)/size.height,1)});}
  useEffect(()=>{const el=canvasElement;if(!el)return;const observer=new ResizeObserver(()=>{const box=el.getBoundingClientRect();setView({x:0,y:0,scale:Math.min((box.width-48)/current.width,(box.height-48)/current.height,1)});});observer.observe(el);return()=>observer.disconnect();},[canvasElement,current.id]);
  useEffect(()=>{const el=canvasElement;if(!el)return;function wheel(e:WheelEvent){e.preventDefault();const box=el!.getBoundingClientRect(),anchor={x:e.clientX-box.left-box.width/2,y:e.clientY-box.top-box.height/2};setView(v=>zoomAt(v,anchor,v.scale*Math.exp(-Math.max(-100,Math.min(100,e.deltaY))*.008)));}el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[canvasElement]);
  function point(e:{clientX:number;clientY:number}){const b=viewport.current!.getBoundingClientRect();return {x:e.clientX-b.left-b.width/2,y:e.clientY-b.top-b.height/2};}
  function rotate(next:number){if(busy)return;const normalized=normalizeAngle(next),delta=normalizeAngle(normalized-angle);setCrop(null);setAngle(normalized);setView(v=>({...v,...rotatePoint(v,delta)}));}
  async function transform(){
    if(!hasTransform||busy)return {asset:current,regions:marks};setBusy(true);setError('');
    try{transformRegions(marks,previewTransform(current.width,current.height,angle,crop??undefined));const a=await request<ReferenceEditResult>('/admin/assets/'+current.id+'/edit',{angle,...(crop?{crop}:{}),regions:marks});setMarks(a.regions);setCurrent(a);setAngle(0);setCrop(null);setTool('move');return {asset:a,regions:a.regions};}catch(e){setError((e as Error).message);return null;}finally{setBusy(false);}
  }
  async function restore(){
    if(!current.originalId){setAngle(0);setCrop(null);fit();return;}setBusy(true);setError('');
    try{let a=current,r=marks,depth=0;if(!marks.length)a=await request<ReferenceAsset>('/admin/assets/'+current.originalId);while(a.id!==current.originalId){if(!a.derivation||depth++>30)throw new Error('这张旧版编辑图片缺少标记变换记录，请先删除区域或取消恢复。');r=transformRegions(r,a.derivation.transform,true);a=await request<ReferenceAsset>('/admin/assets/'+a.derivation.sourceId);}setMarks(r);setCurrent(a);setAngle(0);setCrop(null);setTool('move');}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function apply(){const result=hasTransform?await transform():{asset:current,regions:marks};if(result)onApply(result.asset,result.regions);}
  const displayMarks=angle?transformRegions(marks,previewTransform(current.width,current.height,angle)):marks;
  function finishDrawing(){const d=drawing,kind=drag.current?.tool;drag.current=null;setDrawing(null);if(!d||d.width*size.width<16||d.height*size.height<16)return;if(kind==='crop'){setCrop(d);return;}if(kind==='focus'||kind==='ignore'){if(marks.some(m=>m.kind!==kind&&regionsOverlap(m,d))){setError('忽略区域与重点区域不能重叠，请重新框选。');return;}const id=clientId();setMarks(v=>[...v,{...d,id,kind,label:''}]);setSelected(id);}}
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="sv-dialog ref-editor-dialog" showCloseButton={false}>
    <header className="ref-editor-heading"><div><DialogTitle>图片编辑与识别范围</DialogTitle><DialogDescription>裁剪保留完整元件和适当留白；已有标记随图变换，不重新分析。</DialogDescription></div><Btn type="button" tone="quiet" aria-label="关闭图片编辑" disabled={busy} onClick={onClose}><X size={20}/></Btn></header>
    <div className="ref-editor-tools" aria-label="图片编辑工具栏">{([['move','移动',Hand],['crop','裁剪',Crop],['ignore','忽略框',SquareDashed],['focus','重点框',Scan]] as const).map(([value,label,Icon])=><Btn type="button" key={value} aria-pressed={tool===value} tone={tool===value?'primary':'quiet'} disabled={busy||hasTransform&&(value==='ignore'||value==='focus')} onClick={()=>{setTool(value);setError('');}}><Icon size={16}/>{label}</Btn>)}
      <Btn type="button" tone="quiet" disabled={busy} onClick={()=>void restore()} title="恢复上传原图，保留原图文件"><RotateCcw size={16}/>恢复原图</Btn><span className="ref-tool-divider"/>
      <label className="ref-zoom">缩放<input aria-label="图片缩放" type="range" min={Math.min(.01,view.scale)} max={Math.max(4,view.scale)} step=".01" value={view.scale} onChange={e=>setView(v=>zoomAt(v,{x:0,y:0},Number(e.target.value)))}/><output>{Math.round(view.scale*100)}%</output></label>
      <RotationDial value={angle} disabled={busy} onChange={rotate}/><label className="ref-angle"><input aria-label="旋转角度" type="number" min="-180" max="180" step="1" value={Math.round(angle*10)/10} onChange={e=>{if(e.target.value!==''&&e.target.validity.valid)rotate(Number(e.target.value));}}/>°</label>
      <Btn type="button" tone="quiet" onClick={fit}>适应</Btn>{hasTransform?<Btn type="button" disabled={busy} onClick={()=>void transform()}>{busy?<Spinner/>:null}应用裁剪 / 旋转</Btn>:null}
    </div>
    {error?<p className="adm-error" role="alert">{error}</p>:null}
    <div className="ref-editor-body"><div className={'ref-canvas ref-tool-'+tool} ref={bindViewport} tabIndex={0} aria-label="图片画布，可滚轮缩放、拖动移动或框选" onKeyDown={e=>{if(e.key==='Escape'){drag.current=null;setDrawing(null);setTool('move');e.stopPropagation();}if(e.key==='0')fit();}} onPointerDown={e=>{if(busy||e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const p=point(e);drag.current={start:p,view:{...view},image:imagePoint(p,view,size),tool};setError('');}}
      onPointerMove={e=>{const d=drag.current;if(!d)return;const p=point(e);if(d.tool==='move')setView({...d.view,x:d.view.x+p.x-d.start.x,y:d.view.y+p.y-d.start.y});else setDrawing(rectBetween(d.image,imagePoint(p,d.view,size)));}}
      onPointerUp={finishDrawing} onPointerCancel={()=>{drag.current=null;setDrawing(null);}}>
      <div className="ref-stage" style={{width:size.width,height:size.height,transform:`translate3d(${view.x}px,${view.y}px,0) scale(${view.scale}) translate(-50%,-50%)`}}>
        <img draggable={false} src={apiPath('/reference-assets/'+current.id)} alt="正在编辑的正品图片" style={{width:current.width,height:current.height,left:(size.width-current.width)/2,top:(size.height-current.height)/2,transform:`rotate(${angle}deg)`}}/>
        <RegionOverlay regions={displayMarks} width={size.width} height={size.height}/>{[...(crop?[{...crop,id:'crop',style:'crop',label:'整件裁剪'}]:[]),...(drawing?[{...drawing,id:'drawing',style:tool,label:''}]:[])].map(r=><div key={r.id} className={'ref-region '+r.style+(selected===r.id?' selected':'')} style={{left:r.x*size.width,top:r.y*size.height,width:r.width*size.width,height:r.height*size.height,borderWidth:2/view.scale}}><span style={{transform:`scale(${1/view.scale})`}}>{r.style==='focus'?'重点':r.style==='ignore'?'忽略':r.label}</span></div>)}
      </div><div className="ref-canvas-hint">滚轮：鼠标位置缩放 · 拖动：{tool==='move'?'移动图片':'绘制区域'}</div>
    </div><aside className="ref-region-settings"><h3>识别范围</h3><p className="adm-footnote">绿色：只检查框内丝印<br/>黄色：忽略对应位置的变化</p>{hasTransform?<p className="ref-edit-notice">已有标记随图片变换；先应用裁剪 / 旋转，再添加新标记。</p>:null}
      {!marks.length?<p className="adm-footnote">尚无标记，默认检查整个元件。选择工具后在图上拖动即可框选。</p>:marks.map((m,i)=><div className={'ref-region-row '+(selected===m.id?'selected':'')} key={m.id}><button type="button" className={'ref-mark-label '+m.kind} onClick={()=>setSelected(m.id)}>{m.kind==='focus'?'重点区':'忽略区'} {i+1}</button><input aria-label={'区域 '+(i+1)+' 说明'} maxLength={300} placeholder={m.kind==='ignore'?'可变编号等说明（选填）':'重点检查内容（选填）'} value={m.label} onChange={e=>setMarks(v=>v.map(r=>r.id===m.id?{...r,label:e.target.value}:r))}/><button type="button" className="ref-delete-region" aria-label={'删除区域 '+(i+1)} onClick={()=>setMarks(v=>v.filter(r=>r.id!==m.id))}><Trash2 size={16}/></button></div>)}
      {marks.length?<p className="adm-footnote">区域说明只针对对应位置，不会全局忽略相同文字。保存后随正品标准一起用于检测。</p>:null}
    </aside></div>
    <footer className="ref-editor-footer"><span>原始图片始终保留；缩放、平移不会修改图片。</span><Btn type="button" disabled={busy} onClick={onClose}>取消</Btn><Btn type="button" tone="primary" disabled={busy} onClick={()=>void apply()}>{busy?<Spinner/>:null}应用到标准</Btn></footer>
  </DialogContent></Dialog>;
}
function RotationDial({value,onChange,disabled}:{value:number;onChange:(n:number)=>void;disabled:boolean}){
  const start=useRef<{angle:number;value:number;previous:number;total:number}|null>(null);
  function degrees(e:{clientX:number;clientY:number},el:HTMLElement){const b=el.getBoundingClientRect();return Math.atan2(e.clientY-b.top-b.height/2,e.clientX-b.left-b.width/2)*180/Math.PI;}
  return <div className="ref-rotation-control"><span>旋转</span><div className="ref-rotation-dial" role="slider" tabIndex={disabled?-1:0} aria-label="拖动旋转环" aria-valuemin={-180} aria-valuemax={180} aria-valuenow={Math.round(value)} aria-valuetext={Math.round(value)+' 度'} aria-disabled={disabled}
    onKeyDown={e=>{if(disabled)return;if(e.key==='ArrowLeft'||e.key==='ArrowDown'){e.preventDefault();onChange(value-(e.shiftKey?15:1));}if(e.key==='ArrowRight'||e.key==='ArrowUp'){e.preventDefault();onChange(value+(e.shiftKey?15:1));}if(e.key==='Home'){e.preventDefault();onChange(0);}}}
    onPointerDown={e=>{if(disabled)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const a=degrees(e,e.currentTarget);start.current={angle:a,previous:a,value,total:0};}}
    onPointerMove={e=>{const s=start.current;if(!s)return;const a=degrees(e,e.currentTarget);s.total+=normalizeAngle(a-s.previous);s.previous=a;onChange(s.value+s.total);}}
    onPointerUp={()=>{start.current=null;}} onPointerCancel={()=>{start.current=null;}}><i style={{transform:`rotate(${value}deg)`}}/></div></div>;
}

import { clientId } from '../../../shared/client-id';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Crop, MousePointer2, Redo2, RotateCcw, Scan, SquareDashed, Trash2, Undo2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Btn, Spinner } from '../ui';
import { request } from '../api';
import { apiPath } from '../../../shared/paths';
import { ImagePinch } from '../../../shared/image-gestures';
import { useImageWheel } from '../use-image-wheel';
import { imagePoint, normalizeAngle, rectBetween, rotatedSize, rotatePoint } from '../../../shared/image-editor';
import type { Point, Rect, View } from '../../../shared/image-editor';
import { previewTransform, regionsOverlap, transformRegions } from '../../../shared/reference-geometry';
import { EditHistory, moveRegion, regionAngle, regionCenter, resizeRegion, rotateRegion } from '../../../shared/region-editor';
import { EditableRegions } from './editable-regions';
import type { ReferenceAsset, ReferenceEditResult, ReferenceRegion } from '../../../shared/admin';

type Tool='move'|'crop'|'ignore'|'focus';
type Document={current:ReferenceAsset;marks:ReferenceRegion[];angle:number;crop:Rect|null};
type Drag={start:Point;view:View;image:Point;size:{width:number;height:number};baseline:Document;tool:Tool;region?:ReferenceRegion;action?:string;corner?:number};
export function ReferenceImageEditor({asset,regions=[],initialTool='move',onApply,onClose}:{asset:ReferenceAsset;regions?:ReferenceRegion[];initialTool?:Tool;onApply:(a:ReferenceAsset,r:ReferenceRegion[])=>void;onClose:()=>void}){
  const [history]=useState(()=>new EditHistory<Document>({current:asset,marks:regions,angle:0,crop:null}));
  const [document,setDocument]=useState(()=>structuredClone(history.value)),documentRef=useRef(document);
  const {current,marks,angle,crop}=document;
  const [tool,setTool]=useState<Tool>(initialTool),[view,setView]=useState<View>({x:0,y:0,scale:1}),[drawing,setDrawing]=useState<Rect|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState('');
  const [canvasElement,setCanvasElement]=useState<HTMLDivElement|null>(null),[canvasSize,setCanvasSize]=useState({width:1,height:1});
  const viewport=useRef<HTMLDivElement>(null),bindViewport=useCallback((node:HTMLDivElement|null)=>{viewport.current=node;setCanvasElement(node);},[]),drag=useRef<Drag|null>(null),drawingRef=useRef<Rect|null>(null),touch=useRef(new ImagePinch());
  const size=rotatedSize(current.width,current.height,angle),hasTransform=!!angle||!!crop,active=marks.find(r=>r.id===selected);
  function preview(next:Document){documentRef.current=next;setDocument(next);}
  function commit(next=documentRef.current){history.commit(next);preview(structuredClone(history.value));}
  function clearDrawing(){drawingRef.current=null;setDrawing(null);}
  function cancelDrag(){if(drag.current)preview(drag.current.baseline);drag.current=null;clearDrawing();touch.current.clear();}
  function replay(redo=false){cancelDrag();const next=redo?history.redo():history.undo();preview(next);setSelected(id=>next.marks.some(m=>m.id===id)?id:next.marks.at(-1)?.id??'');setError('');}
  function fit(){const el=viewport.current;if(el&&el.clientWidth>48&&el.clientHeight>48)setView({x:0,y:0,scale:Math.min((el.clientWidth-48)/size.width,(el.clientHeight-48)/size.height,16)});}
  const fitRef=useRef(fit);fitRef.current=fit;
  useEffect(()=>{const el=canvasElement;if(!el)return;const resize=()=>{setCanvasSize({width:el.clientWidth,height:el.clientHeight});fitRef.current();};const observer=new ResizeObserver(resize);observer.observe(el);resize();return()=>observer.disconnect();},[canvasElement,current.id]);
  useImageWheel(canvasElement,setView,cancelDrag,busy);
  function point(e:{clientX:number;clientY:number}){const el=viewport.current!,b=el.getBoundingClientRect();return {x:(e.clientX-b.left)*el.clientWidth/b.width-el.clientWidth/2,y:(e.clientY-b.top)*el.clientHeight/b.height-el.clientHeight/2};}
  function rawPoint(p:Point,v:View,s:{width:number;height:number}):Point{return{x:((p.x-v.x)/v.scale+s.width/2)/s.width,y:((p.y-v.y)/v.scale+s.height/2)/s.height};}
  function rotate(next:number){if(busy)return;const before=documentRef.current,normalized=normalizeAngle(next),delta=normalizeAngle(normalized-before.angle);if(!delta)return;preview({...before,angle:normalized,crop:null});setView(v=>({...v,...rotatePoint(v,delta)}));}
  function updateRegion(next:ReferenceRegion|null,remember=false){
    if(!next){setError('选区不能超出图片范围，请缩小选区或调整位置后再旋转。');return false;}
    const before=documentRef.current;if(before.marks.some(m=>m.id!==next.id&&m.kind!==next.kind&&regionsOverlap(m,next))){setError('忽略区域与重点区域不能重叠，已保留最后有效位置。');return false;}
    const changed={...before,marks:before.marks.map(m=>m.id===next.id?next:m)};if(remember)commit(changed);else preview(changed);setError('');return true;
  }
  function rotateSelected(value:number){const before=documentRef.current,m=before.marks.find(r=>r.id===selected);if(!m||hasTransform||busy)return;updateRegion(rotateRegion(m,normalizeAngle(value-regionAngle(m,before.current)),before.current));}
  function remove(id:string){commit({...documentRef.current,marks:documentRef.current.marks.filter(r=>r.id!==id)});if(selected===id)setSelected('');setError('');}
  async function transform(){
    const before=documentRef.current;if(!before.angle&&!before.crop||busy)return {asset:before.current,regions:before.marks};commit();setBusy(true);setError('');
    try{transformRegions(before.marks,previewTransform(before.current.width,before.current.height,before.angle,before.crop??undefined));const a=await request<ReferenceEditResult>('/admin/assets/'+before.current.id+'/edit',{angle:before.angle,...(before.crop?{crop:before.crop}:{}),regions:before.marks});commit({current:a,marks:a.regions,angle:0,crop:null});setTool('move');return {asset:a,regions:a.regions};}catch(e){setError((e as Error).message);return null;}finally{setBusy(false);}
  }
  async function restore(){
    commit();const before=documentRef.current;if(!before.current.originalId){commit({...before,angle:0,crop:null});fit();return;}setBusy(true);setError('');
    try{let a=before.current,r=before.marks,depth=0;if(!r.length)a=await request<ReferenceAsset>('/admin/assets/'+a.originalId);while(a.id!==before.current.originalId){if(!a.derivation||depth++>30)throw new Error('这张旧版编辑图片缺少标记变换记录，请先删除区域或取消恢复。');r=transformRegions(r,a.derivation.transform,true);a=await request<ReferenceAsset>('/admin/assets/'+a.derivation.sourceId);}commit({current:a,marks:r,angle:0,crop:null});setTool('move');}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function apply(){commit();const before=documentRef.current,result=before.angle||before.crop?await transform():{asset:before.current,regions:before.marks};if(result)onApply(result.asset,result.regions);}
  const displayMarks=angle?transformRegions(marks,previewTransform(current.width,current.height,angle)):marks;
  function finish(){
    const d=drawingRef.current,interaction=drag.current;drag.current=null;clearDrawing();if(!interaction)return;
    if(interaction.region){commit();return;}
    if(!d||d.width*size.width<16||d.height*size.height<16)return;
    if(interaction.tool==='crop'){commit({...documentRef.current,crop:d});return;}
    const kind=interaction.tool;if(kind!=='ignore'&&kind!=='focus')return;
    const before=documentRef.current;if(before.marks.length>=30){setError('最多可添加 30 个区域。');return;}if(before.marks.some(m=>m.kind!==kind&&regionsOverlap(m,d))){setError('忽略区域与重点区域不能重叠，请重新框选。');return;}
    const id=clientId();commit({...before,marks:[...before.marks,{...d,id,kind,label:''}]});setSelected(id);
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="sv-dialog ref-editor-dialog" showCloseButton={false} onKeyDown={e=>{
    const target=e.target as HTMLElement;if(busy||target.closest('input,textarea,select,[contenteditable=true]'))return;
    if((e.metaKey||e.ctrlKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();e.stopPropagation();replay(e.shiftKey||e.key.toLowerCase()==='y');}
  }}>
    <header className="ref-editor-heading"><div><DialogTitle>图片编辑与识别范围</DialogTitle><DialogDescription>选中区域可移动、缩放和旋转；图片裁剪保留完整元件和适当留白。</DialogDescription></div><Btn type="button" tone="quiet" aria-label="关闭图片编辑" disabled={busy} onClick={onClose}><X size={20}/></Btn></header>
    <div className="ref-editor-tools" aria-label="图片编辑工具栏">{([['move','选择 / 移动',MousePointer2],['crop','裁剪',Crop],['ignore','忽略框',SquareDashed],['focus','重点框',Scan]] as const).map(([value,label,Icon])=><Btn type="button" key={value} aria-pressed={tool===value} tone={tool===value?'primary':'quiet'} disabled={busy||hasTransform&&(value==='ignore'||value==='focus')} onClick={()=>{setTool(value);setError('');}}><Icon size={16}/>{label}</Btn>)}
      <span className="ref-tool-divider"/><Btn type="button" tone="quiet" aria-label="撤销上一步" title="撤销 Ctrl / ⌘ Z" disabled={busy||!history.canUndo} onClick={()=>replay()}><Undo2 size={16}/>撤销</Btn><Btn type="button" tone="quiet" aria-label="重做上一步" title="重做 Ctrl / ⌘ Shift Z" disabled={busy||!history.canRedo} onClick={()=>replay(true)}><Redo2 size={16}/>重做</Btn>
      <Btn type="button" tone="quiet" disabled={busy} onClick={()=>void restore()} title="恢复上传原图，可撤销"><RotateCcw size={16}/>恢复原图</Btn><span className="ref-tool-divider"/>
      <RotationDial label="图片旋转" value={angle} disabled={busy} onChange={rotate} onCommit={()=>commit()}/><label className="ref-angle"><input aria-label="图片旋转角度" type="number" min="-180" max="180" step="0.1" disabled={busy} value={Math.round(angle*10)/10} onChange={e=>{if(e.target.value!==''&&e.target.validity.valid)rotate(Number(e.target.value));}} onBlur={()=>commit()}/>°</label>
      <output className="ref-zoom-value" aria-label="当前图片缩放">{Math.round(view.scale*100)}%</output><Btn type="button" tone="quiet" disabled={busy} onClick={fit}>适应</Btn>{hasTransform?<Btn type="button" disabled={busy} onClick={()=>void transform()}>{busy?<Spinner/>:null}应用裁剪 / 旋转</Btn>:null}
    </div>
    <div className="ref-editor-body"><div className={'ref-canvas ref-tool-'+tool} ref={bindViewport} tabIndex={0} aria-label="图片画布，可滚轮缩放、拖动移动或框选" onKeyDown={e=>{
      if(busy)return;if(e.key==='Escape'){cancelDrag();setTool('move');e.stopPropagation();}if(e.key==='0')fit();
      if(active&&!hasTransform&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const step=e.shiftKey?10:1;updateRegion(moveRegion(active,{x:(e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0)/current.width,y:(e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0)/current.height}),true);}
      if(active&&!hasTransform&&(e.key==='Delete'||e.key==='Backspace')){e.preventDefault();remove(active.id);}
    }} onPointerDown={e=>{
      if(busy||e.button!==0)return;e.preventDefault();e.currentTarget.focus({preventScroll:true});e.currentTarget.setPointerCapture(e.pointerId);const p=point(e);
      if(touch.current.start(e.pointerId,p,view)){if(drag.current)preview(drag.current.baseline);drag.current=null;clearDrawing();return;}
      commit();const target=(e.target as Element).closest('[data-region-id]'),id=target?.getAttribute('data-region-id'),region=id==='crop'&&crop?{...crop,id:'crop',kind:'focus' as const,label:'整件裁剪'}:!hasTransform&&tool!=='crop'?documentRef.current.marks.find(m=>m.id===id):undefined;
      if(region)setSelected(region.id);else setSelected('');
      drag.current={start:p,view:{...view},image:rawPoint(p,view,size),size:{...size},baseline:documentRef.current,tool,region,action:target?.getAttribute('data-region-action')??'move',corner:Number(target?.getAttribute('data-corner')??0)};setError('');
    }} onPointerMove={e=>{
      if(!touch.current.points.has(e.pointerId))return;const p=point(e),pinched=touch.current.move(e.pointerId,p);if(pinched){setView(pinched);return;}const d=drag.current;if(!d||touch.current.active)return;
      if(d.region){const target=rawPoint(p,d.view,d.size),change=(r:ReferenceRegion|null)=>{if(d.region?.id==='crop'&&r){const {x,y,width,height}=r;preview({...documentRef.current,crop:{x,y,width,height}});}else updateRegion(r);};if(d.action==='resize')change(resizeRegion(d.region,d.corner??0,target,d.region.id==='crop'?d.size:d.baseline.current));else if(d.action==='rotate'){const c=regionCenter(d.region),degrees=(q:Point)=>Math.atan2((q.y-c.y)*d.size.height,(q.x-c.x)*d.size.width)*180/Math.PI;change(rotateRegion(d.region,normalizeAngle(degrees(target)-degrees(d.image)),d.baseline.current));}else change(moveRegion(d.region,{x:target.x-d.image.x,y:target.y-d.image.y}));}
      else if(d.tool==='move')setView({...d.view,x:d.view.x+p.x-d.start.x,y:d.view.y+p.y-d.start.y});
      else{const next=rectBetween(imagePoint(d.start,d.view,d.size),imagePoint(p,d.view,d.size));drawingRef.current=next;setDrawing(next);}
    }} onPointerUp={e=>{if(touch.current.end(e.pointerId))return;finish();}} onPointerCancel={cancelDrag}>
      <div className="ref-stage" style={{width:size.width,height:size.height,transform:`translate3d(${view.x}px,${view.y}px,0) scale(${view.scale}) translate(-50%,-50%)`}}>
        <img draggable={false} src={apiPath('/reference-assets/'+current.id)} alt="正在编辑的正品图片" style={{width:current.width,height:current.height,left:(size.width-current.width)/2,top:(size.height-current.height)/2,transform:`rotate(${angle}deg)`}}/>
        {(drawing?[{...drawing,id:'drawing',style:tool,label:''}]:[]).map(r=><div key={r.id} className={'ref-region '+r.style} style={{left:r.x*size.width,top:r.y*size.height,width:r.width*size.width,height:r.height*size.height,borderWidth:2/view.scale}}><span style={{transform:`scale(${1/view.scale})`}}>{r.style==='focus'?'重点':r.style==='ignore'?'忽略':r.label}</span></div>)}
      </div>
      <EditableRegions regions={displayMarks} selected={selected} view={view} size={size} viewport={canvasSize} enabled={!busy&&!hasTransform&&tool!=='crop'} crop={crop} cropEditable={!busy&&tool==='crop'}/>
      {error?<p className="adm-error ref-editor-error" role="alert">{error}</p>:null}
      <div className="ref-canvas-hint">滚轮 / 双指缩放 · {active&&!hasTransform?'拖框移动，拖角缩放，圆点旋转':tool==='move'?'拖空白移动图片，点击区域编辑':'拖动绘制区域'}</div>
    </div><aside className="ref-region-settings"><h3>识别范围</h3><p className="adm-footnote">绿色：只检查框内丝印<br/>黄色：忽略对应位置的变化</p>{hasTransform?<p className="ref-edit-notice">先应用图片裁剪 / 旋转，再调整区域；已有框随图同步变换。</p>:null}{crop?<><p className="adm-footnote">裁剪框可拖动、拖角缩放；通过上方“图片旋转”转正。</p><Btn type="button" tone="quiet" disabled={busy} onClick={()=>{commit({...documentRef.current,crop:null});setTool('crop');}}>重新框选裁剪</Btn></>:null}
      {active?<section className="ref-active-region"><strong>已选{active.kind==='focus'?'重点区':'忽略区'} {marks.indexOf(active)+1}</strong><label>区域用途<select aria-label="选中区域用途" disabled={busy||hasTransform} value={active.kind} onChange={e=>updateRegion({...active,kind:e.target.value as 'ignore'|'focus'},true)}><option value="ignore">忽略对应位置的变化</option><option value="focus">只检查框内丝印</option></select></label><label className="ref-angle">选区旋转<input aria-label="选区旋转角度" type="number" min="-180" max="180" step="0.1" disabled={busy||hasTransform} value={Math.round(regionAngle(active,current)*10)/10} onChange={e=>{if(e.target.value!==''&&e.target.validity.valid)rotateSelected(Number(e.target.value));}} onBlur={()=>commit()}/>°</label><p>拖动四角调整大小；方向键微移，Shift 加速。</p></section>:null}
      {!marks.length?<p className="adm-footnote">尚无标记，默认检查整个元件。选择忽略框或重点框后在图上拖动。</p>:marks.map((m,i)=><div className={'ref-region-row '+(selected===m.id?'selected':'')} key={m.id}><button type="button" className={'ref-mark-label '+m.kind} disabled={busy} onClick={()=>setSelected(m.id)}>{m.kind==='focus'?'重点区':'忽略区'} {i+1}</button><input aria-label={'区域 '+(i+1)+' 说明'} disabled={busy} maxLength={300} placeholder={m.kind==='ignore'?'可变编号等说明（选填）':'重点检查内容（选填）'} value={m.label} onChange={e=>preview({...documentRef.current,marks:documentRef.current.marks.map(r=>r.id===m.id?{...r,label:e.target.value}:r)})} onBlur={()=>commit()}/><button type="button" className="ref-delete-region" disabled={busy} aria-label={'删除区域 '+(i+1)} onClick={()=>remove(m.id)}><Trash2 size={16}/></button></div>)}
      {marks.length?<p className="adm-footnote">区域说明只针对对应位置；保存标准后用于检测。撤销 / 重做仅作用本次编辑。</p>:null}
    </aside></div>
    <footer className="ref-editor-footer"><span>原始图片始终保留；缩放、平移不进入撤销历史。</span><Btn type="button" disabled={busy} onClick={onClose}>取消</Btn><Btn type="button" tone="primary" disabled={busy} onClick={()=>void apply()}>{busy?<Spinner/>:null}应用到标准</Btn></footer>
  </DialogContent></Dialog>;
}
function RotationDial({value,onChange,onCommit,disabled,label}:{value:number;onChange:(n:number)=>void;onCommit:()=>void;disabled:boolean;label:string}){
  const start=useRef<{previous:number;value:number;total:number}|null>(null);
  function degrees(e:{clientX:number;clientY:number},el:HTMLElement){const b=el.getBoundingClientRect();return Math.atan2(e.clientY-b.top-b.height/2,e.clientX-b.left-b.width/2)*180/Math.PI;}
  return <div className="ref-rotation-control"><span>{label}</span><div className="ref-rotation-dial" role="slider" tabIndex={disabled?-1:0} aria-label="拖动图片旋转环" aria-valuemin={-180} aria-valuemax={180} aria-valuenow={Math.round(value)} aria-valuetext={Math.round(value)+' 度'} aria-disabled={disabled}
    onKeyDown={e=>{if(disabled)return;let next=value;if(e.key==='ArrowLeft'||e.key==='ArrowDown')next-=e.shiftKey?15:1;else if(e.key==='ArrowRight'||e.key==='ArrowUp')next+=e.shiftKey?15:1;else if(e.key==='Home')next=0;else return;e.preventDefault();onChange(next);onCommit();}}
    onPointerDown={e=>{if(disabled)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);start.current={previous:degrees(e,e.currentTarget),value,total:0};}}
    onPointerMove={e=>{const s=start.current;if(!s)return;const a=degrees(e,e.currentTarget);s.total+=normalizeAngle(a-s.previous);s.previous=a;onChange(s.value+s.total);}}
    onPointerUp={()=>{start.current=null;onCommit();}} onPointerCancel={()=>{start.current=null;onCommit();}}><i style={{transform:`rotate(${value}deg)`}}/></div></div>;
}

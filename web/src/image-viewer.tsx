import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Btn } from './ui';
import { RegionOverlay } from './reference-image';
import type { ReferenceRegion } from '../../shared/admin';
import { zoomAt } from '../../shared/image-editor';
import type { Point, View } from '../../shared/image-editor';
import './image-viewer.css';

/** 可查看原始像素的公共组件；浏览变换不写回文件或区域坐标。 */
export function ZoomImage({src,alt,regions=[]}:{src:string;alt:string;regions?:ReferenceRegion[]}){
 const area=useRef<HTMLDivElement>(null),[size,setSize]=useState({width:1,height:1}),[view,setView]=useState<View>({x:0,y:0,scale:1}),[fitScale,setFitScale]=useState(1),[error,setError]=useState(false);
 const pointers=useRef(new Map<number,Point>()),gesture=useRef<{view:View;center:Point;distance:number}|null>(null),drag=useRef<{view:View;point:Point}|null>(null);
 function fit(){const r=area.current?.getBoundingClientRect();if(r){const scale=Math.min((r.width-24)/size.width,(r.height-24)/size.height,1);setFitScale(scale);setView({x:0,y:0,scale});}}
 useEffect(()=>{setError(false);setSize({width:1,height:1});},[src]);
 useEffect(()=>{const el=area.current;if(!el)return;const observer=new ResizeObserver(fit);observer.observe(el);fit();return()=>observer.disconnect();},[size.width,size.height]);
 useEffect(()=>{const el=area.current;if(!el)return;function wheel(e:WheelEvent){e.preventDefault();const b=el!.getBoundingClientRect();setView(v=>zoomAt(v,{x:e.clientX-b.left-b.width/2,y:e.clientY-b.top-b.height/2},v.scale*Math.exp(-Math.max(-100,Math.min(100,e.deltaY))*.008)));}el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[]);
 function point(e:{clientX:number;clientY:number}){const b=area.current!.getBoundingClientRect();return {x:e.clientX-b.left-b.width/2,y:e.clientY-b.top-b.height/2};}
 function startGesture(){const [a,b]=[...pointers.current.values()];if(a&&b){gesture.current={view:{...view},center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};drag.current=null;}}
 function end(id:number){pointers.current.delete(id);gesture.current=null;const remaining=pointers.current.values().next().value;drag.current=remaining?{view:{...view},point:remaining}:null;}
 return <div className="sv-zoom-image"><div className="sv-zoom-controls"><Btn tone="quiet" aria-label="缩小图片" onClick={()=>setView(v=>zoomAt(v,{x:0,y:0},v.scale/1.3))}><Minus size={16}/></Btn><input type="range" aria-label="原图缩放比例" min={Math.min(fitScale/4,view.scale,.01)} max={Math.max(4,view.scale)} step=".01" value={view.scale} onChange={e=>setView(v=>zoomAt(v,{x:0,y:0},Number(e.target.value)))}/><output>{Math.round(view.scale*100)}%</output><Btn tone="quiet" aria-label="放大图片" onClick={()=>setView(v=>zoomAt(v,{x:0,y:0},v.scale*1.3))}><Plus size={16}/></Btn><Btn tone="quiet" onClick={fit}>适应</Btn><span>拖动移动 · 双指 / 滚轮缩放</span></div>
 <div className="sv-zoom-area" ref={area} tabIndex={0} aria-label={alt+'，可缩放拖动'} onDoubleClick={()=>Math.abs(view.scale-fitScale)<.001?setView({x:0,y:0,scale:Math.max(1,fitScale*2)}):fit()} onKeyDown={e=>{if(e.key==='+'||e.key==='='){e.preventDefault();setView(v=>zoomAt(v,{x:0,y:0},v.scale*1.3));}if(e.key==='-'){e.preventDefault();setView(v=>zoomAt(v,{x:0,y:0},v.scale/1.3));}if(e.key==='0')fit();}}
 onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const p=point(e);pointers.current.set(e.pointerId,p);if(pointers.current.size>1)startGesture();else drag.current={view:{...view},point:p};}}
 onPointerMove={e=>{if(!pointers.current.has(e.pointerId))return;const p=point(e);pointers.current.set(e.pointerId,p);const g=gesture.current;if(g&&pointers.current.size>=2){const [a,b]=[...pointers.current.values()],center={x:(a.x+b.x)/2,y:(a.y+b.y)/2},next=zoomAt(g.view,g.center,g.view.scale*Math.hypot(a.x-b.x,a.y-b.y)/g.distance);setView({...next,x:next.x+center.x-g.center.x,y:next.y+center.y-g.center.y});}else if(drag.current){const d=drag.current;setView({...d.view,x:d.view.x+p.x-d.point.x,y:d.view.y+p.y-d.point.y});}}}
 onPointerUp={e=>end(e.pointerId)} onPointerCancel={e=>end(e.pointerId)}>
 <div className="sv-zoom-stage" style={{width:size.width,height:size.height,transform:`translate3d(${view.x}px,${view.y}px,0) scale(${view.scale}) translate(-50%,-50%)`}}><img draggable={false} src={src} alt={alt} onLoad={e=>{setSize({width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight});setError(false);}} onError={()=>setError(true)}/>{regions.length?<RegionOverlay regions={regions} width={size.width} height={size.height}/>:null}</div>{error?<p role="alert">图片未能加载，请重新打开。</p>:null}</div></div>;
}

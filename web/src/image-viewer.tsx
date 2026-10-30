import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { RegionOverlay } from './reference-image';
import type { ReferenceRegion } from '../../shared/admin';
import { fitImageView, pinchStart, pinchView } from '../../shared/image-gestures';
import type { Pinch } from '../../shared/image-gestures';
import { useImageWheel } from './use-image-wheel';
import { zoomAt } from '../../shared/image-editor';
import type { Point, View } from '../../shared/image-editor';
import './image-viewer.css';

/** 可查看原始像素的公共组件；浏览变换不写回文件或区域坐标。 */
interface ZoomImageProps {src:string;alt:string;regions?:ReferenceRegion[];width?:number;height?:number}
export function ZoomImage(props:ZoomImageProps){return <ZoomImageContent key={props.src} {...props}/>;}
function ZoomImageContent({src,alt,regions=[],width,height}:ZoomImageProps){
 const [element,setElement]=useState<HTMLDivElement|null>(null),area=useRef<HTMLDivElement>(null),bindArea=useCallback((node:HTMLDivElement|null)=>{area.current=node;setElement(node);},[]),[size,setSize]=useState<{width:number;height:number}|null>(null),[view,setView]=useState<View>({x:0,y:0,scale:1}),[fitScale,setFitScale]=useState(1),[error,setError]=useState(false);
 // 缓存命中时 load 可能早于普通 effect；挂载时也读取 naturalSize，不再用 effect 重置成 1×1。
 const readImage=useCallback((image:HTMLImageElement|null)=>{if(!image?.complete||!image.naturalWidth||!image.naturalHeight)return;const next={width:image.naturalWidth,height:image.naturalHeight};setSize(old=>old?.width===next.width&&old.height===next.height?old:next);setError(false);},[]);
 const pointers=useRef(new Map<number,Point>()),gesture=useRef<Pinch|null>(null),drag=useRef<{view:View;point:Point}|null>(null);
 const imageWidth=size?.width,imageHeight=size?.height;
 const fit=useCallback(()=>{const el=area.current;if(!el||!imageWidth||!imageHeight)return;const fitted=fitImageView({width:imageWidth,height:imageHeight},{width:el.clientWidth,height:el.clientHeight});if(!fitted)return;setFitScale(fitted.scale);setView(fitted);gesture.current=null;drag.current=null;pointers.current.clear();},[imageWidth,imageHeight]);
 useLayoutEffect(()=>{if(!element)return;const observer=new ResizeObserver(fit);observer.observe(element);fit();return()=>observer.disconnect();},[element,fit]);
 useImageWheel(element,setView,()=>{gesture.current=null;drag.current=null;pointers.current.clear();});
 function point(e:{clientX:number;clientY:number}){const b=area.current!.getBoundingClientRect();return {x:e.clientX-b.left-b.width/2,y:e.clientY-b.top-b.height/2};}
 function startGesture(){const [a,b]=[...pointers.current.values()];if(a&&b){gesture.current=pinchStart(view,a,b);drag.current=null;}}
 function end(id:number){pointers.current.delete(id);gesture.current=null;const remaining=pointers.current.values().next().value;drag.current=remaining?{view:{...view},point:remaining}:null;}
 const aspect=size?size.width/size.height:width&&height?width/height:4/3;
 return <div className="sv-zoom-image" style={{'--sv-image-aspect':aspect} as CSSProperties}>
 <div className="sv-zoom-area" ref={bindArea} tabIndex={0} aria-busy={!size&&!error} aria-label={alt+'，可缩放拖动'} onDoubleClick={()=>Math.abs(view.scale-fitScale)<.001?setView({x:0,y:0,scale:Math.min(16,Math.max(1,fitScale*2))}):fit()} onKeyDown={e=>{if(e.key==='+'||e.key==='='){e.preventDefault();setView(v=>zoomAt(v,{x:0,y:0},v.scale*1.3));}if(e.key==='-'){e.preventDefault();setView(v=>zoomAt(v,{x:0,y:0},v.scale/1.3));}if(e.key==='0')fit();}}
 onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const p=point(e);pointers.current.set(e.pointerId,p);if(pointers.current.size>1)startGesture();else drag.current={view:{...view},point:p};}}
 onPointerMove={e=>{if(!pointers.current.has(e.pointerId))return;const p=point(e);pointers.current.set(e.pointerId,p);const g=gesture.current;if(g&&pointers.current.size>=2){const [a,b]=[...pointers.current.values()];setView(pinchView(g,a,b));}else if(drag.current){const d=drag.current;setView({...d.view,x:d.view.x+p.x-d.point.x,y:d.view.y+p.y-d.point.y});}}}
 onPointerUp={e=>end(e.pointerId)} onPointerCancel={e=>end(e.pointerId)}>
 <div className="sv-zoom-stage" style={{width:size?.width??1,height:size?.height??1,visibility:size?'visible':'hidden',transform:`translate3d(${view.x}px,${view.y}px,0) scale(${view.scale}) translate(-50%,-50%)`}}><img ref={readImage} draggable={false} src={src} alt={alt} onLoad={e=>readImage(e.currentTarget)} onError={()=>setError(true)}/>{regions.length&&size?<RegionOverlay regions={regions} width={size.width} height={size.height}/>:null}</div>{error?<p role="alert">图片未能加载，请重新打开。</p>:!size?<p role="status">正在加载图片…</p>:null}</div></div>;
}

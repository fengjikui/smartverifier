import { useId, useLayoutEffect, useRef, useState } from 'react';
import { componentBox, componentFocus, componentMarkers } from '../../shared/component-view';
import { finalVerdict } from '../../shared/domain';
import type { ComponentResult, Photo } from '../../shared/types';
import './component-image.css';

export interface ComponentAnnotations {components:ComponentResult[];numbers:Map<string,string>;selected?:string;onSelect?:(component:ComponentResult)=>void}

function ComponentMarks({components,numbers,selected,onSelect,width,height,scale}:ComponentAnnotations&{width:number;height:number;scale:number}) {
  const byId=new Map(components.map(c=>[c.id,c]));
  return <>{componentMarkers(components,numbers,width,height,scale).map(marker=>{
    const c=byId.get(marker.id)!,{box:b,badge:r}=marker,active=selected===c.id;
    const verdict=finalVerdict(c),status=!verdict?'待检测':verdict==='PASS'?'合格':'不合格';
    const actionable=!!onSelect&&!!c.ai;
    const x=r.x+r.width/2,y=r.y+r.height/2,edgeX=Math.max(b.x,Math.min(x,b.x+b.width)),edgeY=Math.max(b.y,Math.min(y,b.y+b.height));
    return <g key={c.id} data-component-marker={c.id} className={'sv-component-mark '+(!verdict?'is-pending':verdict==='FAIL'?'is-fail':'is-pass')+(active?' is-current':'')}>
      <title>{'元件 '+marker.number+' · '+status}</title>
      <rect className="sv-component-halo" x={b.x} y={b.y} width={b.width} height={b.height} rx={3/scale} strokeWidth={(active?5:3.5)/scale}/>
      <rect className="sv-component-outline" x={b.x} y={b.y} width={b.width} height={b.height} rx={3/scale} strokeWidth={active?2.5/scale:marker.strokeWidth}/>
      <path className="sv-component-leader" d={`M${x},${y} L${edgeX},${edgeY}`} strokeWidth={marker.strokeWidth}/>
      <g className={'sv-component-badge'+(actionable?' is-actionable':'')} role={actionable?'button':undefined} tabIndex={actionable?0:undefined} aria-label={actionable?'查看元件 '+marker.number+' 检测详情，'+status:undefined} aria-current={active?'true':undefined}
        onPointerDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onClick={actionable?()=>onSelect!(c):undefined}
        onKeyDown={actionable?e=>{e.stopPropagation();if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect!(c);}}:undefined}>
        {actionable?<rect className="sv-component-hit" x={r.x-(44/scale-r.width)/2} y={r.y-(44/scale-r.height)/2} width={44/scale} height={44/scale}/>:null}
        <rect className="sv-component-number-bg" x={r.x} y={r.y} width={r.width} height={r.height} rx={5/scale} strokeWidth={active?2/scale:1/scale}/>
        <text x={x} y={y} dy=".35em" textAnchor="middle" fontSize={marker.fontSize}>{marker.number}</text>
      </g>
    </g>;
  })}</>;
}

export function ComponentOverlay(props:ComponentAnnotations&{width:number;height:number;scale:number}) {
  return <svg className="sv-component-overlay" viewBox={`0 0 ${props.width} ${props.height}`} aria-label="元件位置与编号"><ComponentMarks {...props}/></svg>;
}

/** SVG 视窗直接引用原图像素，不生成裁片，也不修改模型输入。 */
export function FocusedComponent({photo,component}:{photo:Photo;component:ComponentResult}) {
  const clip=useId();
  const box=componentFocus(component,photo.components,photo.width,photo.height);
  const known=!!componentBox(component.bbox,photo.width,photo.height);
  return <svg className="sv-focused-component" role="img" aria-label={known?'当前元件的原图局部视图':'未提供可靠元件位置，显示整张照片'} viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} data-component-focus={component.id} preserveAspectRatio="xMidYMid meet">
    <defs><clipPath id={clip}><rect {...box}/></clipPath></defs>
    <image href={photo.preparation?.uprightUrl??photo.url} x="0" y="0" width={photo.width} height={photo.height} clipPath={`url(#${clip})`}/>
  </svg>;
}

export function AnnotatedPhoto({photo,numbers}:{photo:Photo;numbers:Map<string,string>}) {
  const ref=useRef<SVGSVGElement>(null),[scale,setScale]=useState(1);
  useLayoutEffect(()=>{const el=ref.current;if(!el)return;const update=()=>setScale(Math.min(el.clientWidth/photo.width,el.clientHeight/photo.height)||1);const ro=new ResizeObserver(update);ro.observe(el);update();return()=>ro.disconnect();},[photo.width,photo.height]);
  return <svg ref={ref} className="sv-annotated-photo" role="img" aria-label={'照片 P'+String(photo.sequence).padStart(3,'0')+'，元件位置与编号'} viewBox={`0 0 ${photo.width} ${photo.height}`}>
    <image href={photo.preparation?.uprightUrl??photo.url} width={photo.width} height={photo.height}/>
    <ComponentMarks components={photo.components} numbers={numbers} width={photo.width} height={photo.height} scale={scale}/>
  </svg>;
}

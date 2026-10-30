import { regionPoints } from '../../../shared/reference-geometry';
import type { Point, Rect, View } from '../../../shared/image-editor';
import type { ReferenceRegion } from '../../../shared/admin';

export function EditableRegions({regions,selected,view,size,viewport,enabled,crop,cropEditable=false}:{regions:ReferenceRegion[];selected:string;view:View;size:{width:number;height:number};viewport:{width:number;height:number};enabled:boolean;crop?:Rect|null;cropEditable?:boolean}){
 const cropRegion:ReferenceRegion|undefined=crop?{...crop,id:'crop',kind:'focus',label:'整件裁剪'}:undefined,all=cropRegion?[...regions,cropRegion]:regions;
 const screen=(p:Point)=>({x:(p.x-.5)*size.width*view.scale+view.x,y:(p.y-.5)*size.height*view.scale+view.y}),active=cropEditable?cropRegion:enabled?regions.find(r=>r.id===selected):undefined,points=active?regionPoints(active).map(screen):[];
 const center=points.length?{x:points.reduce((s,p)=>s+p.x,0)/4,y:points.reduce((s,p)=>s+p.y,0)/4}:null;
 const mid=points.length?{x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2}:null;
 const distance=center&&mid?Math.max(1,Math.hypot(mid.x-center.x,mid.y-center.y)):1;
 const rotation=center&&mid?{x:mid.x+(mid.x-center.x)/distance*30,y:mid.y+(mid.y-center.y)/distance*30}:null;
 return <svg className="ref-edit-overlay" viewBox={`${-viewport.width/2} ${-viewport.height/2} ${viewport.width} ${viewport.height}`} aria-label="识别区域与调整手柄">
  {all.map((r,i)=><polygon key={r.id} className={'ref-edit-polygon '+(r.id==='crop'?'crop':r.kind)+(r.id===active?.id?' is-selected':'')+((r.id==='crop'?!cropEditable:!enabled)?' is-locked':'')} data-region-id={r.id} points={regionPoints(r).map(p=>{const q=screen(p);return `${q.x},${q.y}`;}).join(' ')}><title>{r.id==='crop'?'整件裁剪框':`${r.kind==='focus'?'重点区':'忽略区'} ${i+1}`}，拖动移动</title></polygon>)}
  {active?<g className={'ref-edit-handles '+(active.id==='crop'?'crop':active.kind)}>
   {points.map((p,i)=><g key={i} data-region-id={active.id} data-region-action="resize" data-corner={i} className="ref-edit-handle"><title>调整选区角点 {i+1}</title><rect className="ref-handle-hit" x={p.x-14} y={p.y-14} width={28} height={28}/><rect className="ref-handle-dot" x={p.x-4.5} y={p.y-4.5} width={9} height={9} rx={2}/></g>)}
   {active.id!=='crop'&&mid&&rotation?<><line className="ref-handle-stem" x1={mid.x} y1={mid.y} x2={rotation.x} y2={rotation.y}/><g data-region-id={active.id} data-region-action="rotate" className="ref-edit-handle ref-handle-rotate"><title>拖动旋转选区</title><circle className="ref-handle-hit" cx={rotation.x} cy={rotation.y} r={14}/><circle className="ref-handle-dot" cx={rotation.x} cy={rotation.y} r={5}/></g></>:null}
  </g>:null}
 </svg>;
}

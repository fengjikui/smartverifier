import { normalizeAngle, rotatePoint } from './image-editor.ts';
import type { Point } from './image-editor.ts';
import { polygonBounds, regionGeometryValid, regionPoints } from './reference-geometry.ts';
import type { ReferenceRegion } from './admin.ts';

type Size={width:number;height:number};
const rounded=(n:number)=>Math.round(n*1e9)/1e9;
function shaped(region:ReferenceRegion,points:Point[]):ReferenceRegion|null{
 if(points.some(p=>p.x< -1e-8||p.y< -1e-8||p.x>1+1e-8||p.y>1+1e-8))return null;
 const polygon=points.map(p=>({x:rounded(Math.max(0,Math.min(1,p.x))),y:rounded(Math.max(0,Math.min(1,p.y)))}));
 const next={...region,...polygonBounds(polygon),polygon};return regionGeometryValid(next)?next:null;
}
export function moveRegion(region:ReferenceRegion,delta:Point):ReferenceRegion{
 const bounds=polygonBounds(regionPoints(region)),x=Math.max(-bounds.x,Math.min(1-bounds.x-bounds.width,delta.x)),y=Math.max(-bounds.y,Math.min(1-bounds.y-bounds.height,delta.y));
 return shaped(region,regionPoints(region).map(p=>({x:p.x+x,y:p.y+y})))??region;
}
/** 以对角为固定点，沿原来的两条边缩放；不会把旋转框拉回外接矩形。 */
export function resizeRegion(region:ReferenceRegion,corner:number,target:Point,size:Size):ReferenceRegion{
 const p=regionPoints(region).map(q=>({x:q.x*size.width,y:q.y*size.height})),i=((corner%4)+4)%4,op=p[(i+2)%4],a={x:p[(i+1)%4].x-op.x,y:p[(i+1)%4].y-op.y},b={x:p[(i+3)%4].x-op.x,y:p[(i+3)%4].y-op.y},det=a.x*b.y-a.y*b.x;
 if(Math.abs(det)<1e-9)return region;
 const t={x:target.x*size.width-op.x,y:target.y*size.height-op.y},sa=Math.max(16/Math.hypot(a.x,a.y),(t.x*b.y-t.y*b.x)/det),sb=Math.max(16/Math.hypot(b.x,b.y),(a.x*t.y-a.y*t.x)/det);
 function candidate(fraction:number){const u=1+(sa-1)*fraction,v=1+(sb-1)*fraction,next=p.map(q=>({...q}));next[i]={x:op.x+u*a.x+v*b.x,y:op.y+u*a.y+v*b.y};next[(i+1)%4]={x:op.x+u*a.x,y:op.y+u*a.y};next[(i+3)%4]={x:op.x+v*b.x,y:op.y+v*b.y};return shaped(region,next.map(q=>({x:q.x/size.width,y:q.y/size.height})));}
 const complete=candidate(1);if(complete)return complete;
 let low=0,high=1,best=region;for(let n=0;n<28;n++){const mid=(low+high)/2,next=candidate(mid);if(next){best=next;low=mid;}else high=mid;}return best;
}
export function regionCenter(region:ReferenceRegion):Point{const p=regionPoints(region);return{x:p.reduce((s,q)=>s+q.x,0)/4,y:p.reduce((s,q)=>s+q.y,0)/4};}
export function regionAngle(region:ReferenceRegion,size:Size){const p=regionPoints(region);return normalizeAngle(Math.atan2((p[1].y-p[0].y)*size.height,(p[1].x-p[0].x)*size.width)*180/Math.PI);}
/** 用图片像素坐标旋转，非正方形照片上的角度也正确。越界时由调用方提示并保留最后有效位置。 */
export function rotateRegion(region:ReferenceRegion,degrees:number,size:Size):ReferenceRegion|null{
 const c=regionCenter(region);return shaped(region,regionPoints(region).map(p=>{const q=rotatePoint({x:(p.x-c.x)*size.width,y:(p.y-c.y)*size.height},degrees);return{x:c.x+q.x/size.width,y:c.y+q.y/size.height};}));
}

/** 单次拖动只提交一个快照；纯视图缩放和平移不进入文档历史。 */
export class EditHistory<T>{
 private past:T[]=[];private future:T[]=[];private limit:number;value:T;
 constructor(value:T,limit=100){this.value=structuredClone(value);this.limit=limit;}
 get canUndo(){return this.past.length>0;}get canRedo(){return this.future.length>0;}
 commit(next:T){if(JSON.stringify(next)===JSON.stringify(this.value))return false;this.past.push(this.value);if(this.past.length>this.limit)this.past.shift();this.value=structuredClone(next);this.future=[];return true;}
 undo(){if(this.canUndo){this.future.push(this.value);this.value=this.past.pop()!;}return structuredClone(this.value);}
 redo(){if(this.canRedo){this.past.push(this.value);this.value=this.future.pop()!;}return structuredClone(this.value);}
}

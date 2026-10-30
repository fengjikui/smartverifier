import { zoomAt } from './image-editor.ts';
import type { Point, View } from './image-editor.ts';

/** 只在图片与容器尺寸就绪后适应视口；小裁片也可放大，保持完整比例。 */
export function fitImageView(image:{width:number;height:number},area:{width:number;height:number}):View|null{
 if(![image.width,image.height,area.width,area.height].every(n=>Number.isFinite(n)&&n>0)||area.width<=24||area.height<=24)return null;
 return {x:0,y:0,scale:Math.min((area.width-24)/image.width,(area.height-24)/image.height,16)};
}

export interface Pinch { view:View;center:Point;distance:number }
export function pinchStart(view:View,a:Point,b:Point):Pinch{return {view:{...view},center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};}
export function pinchView(pinch:Pinch,a:Point,b:Point):View{const center={x:(a.x+b.x)/2,y:(a.y+b.y)/2},next=zoomAt(pinch.view,pinch.center,pinch.view.scale*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance);return {...next,x:next.x+center.x-pinch.center.x,y:next.y+center.y-pinch.center.y};}
/** 双指开始后，直到手指全部离开都不恢复画框，避免抬起一指时误生成区域。 */
export class ImagePinch {
 points=new Map<number,Point>();active=false;private pinch:Pinch|null=null;
 start(id:number,p:Point,view:View){this.points.set(id,p);if(this.points.size>=2){const [a,b]=[...this.points.values()];this.pinch=pinchStart(view,a,b);this.active=true;}return this.active;}
 move(id:number,p:Point):View|null{if(!this.points.has(id))return null;this.points.set(id,p);if(this.pinch&&this.points.size>=2){const [a,b]=[...this.points.values()];return pinchView(this.pinch,a,b);}return null;}
 end(id:number){const handled=this.active;this.points.delete(id);if(!this.points.size)this.clear();return handled;}
 clear(){this.points.clear();this.pinch=null;this.active=false;}
}
/** 在事件实际落点缩放；不依赖浏览器的页面缩放，也不依赖当前编辑工具。 */
export function bindImageWheel(element:HTMLElement,update:(fn:(v:View)=>View)=>void,onStart=()=>{},disabled=()=>false){
 const wheel=(e:WheelEvent)=>{if(disabled()||!e.deltaY)return;e.preventDefault();e.stopPropagation();const box=element.getBoundingClientRect(),anchor={x:e.clientX-box.left-box.width/2,y:e.clientY-box.top-box.height/2},pixels=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?box.height:1);onStart();update(v=>zoomAt(v,anchor,v.scale*Math.exp(-Math.max(-120,Math.min(120,pixels))*.003)));};
 element.addEventListener('wheel',wheel,{passive:false,capture:true});return ()=>element.removeEventListener('wheel',wheel,{capture:true});
}

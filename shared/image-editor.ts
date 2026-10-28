/** 图片坐标与视窗坐标严格分开；缩放不改变待保存图片或标记。 */
export interface Point { x:number; y:number }
export interface View extends Point { scale:number }
export interface Rect extends Point { width:number; height:number }
export function rotatePoint(p:Point,degrees:number):Point {const r=degrees*Math.PI/180,c=Math.cos(r),s=Math.sin(r);return {x:p.x*c-p.y*s,y:p.x*s+p.y*c};}
export function rotatedSize(width:number,height:number,degrees:number){const r=degrees*Math.PI/180;return {width:Math.abs(width*Math.cos(r))+Math.abs(height*Math.sin(r)),height:Math.abs(height*Math.cos(r))+Math.abs(width*Math.sin(r))};}
export function zoomAt(view:View,anchor:Point,scale:number):View {const next=Math.max(.01,Math.min(16,scale)),ratio=next/view.scale;return {scale:next,x:anchor.x-(anchor.x-view.x)*ratio,y:anchor.y-(anchor.y-view.y)*ratio};}
export function imagePoint(point:Point,view:View,size:{width:number;height:number}):Point{return {x:Math.max(0,Math.min(1,((point.x-view.x)/view.scale+size.width/2)/size.width)),y:Math.max(0,Math.min(1,((point.y-view.y)/view.scale+size.height/2)/size.height))};}
export function rectBetween(a:Point,b:Point):Rect{return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)};}
export function overlaps(a:Rect,b:Rect){return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
export function normalizeAngle(degrees:number){return ((degrees+180)%360+360)%360-180;}
/** VLM 矩形位于旋转前原图，转换到旋转后画布再裁剪。 */
export function cropAfterRotation(rect:Rect,width:number,height:number,angle:number):Rect {const size=rotatedSize(width,height,angle),points=[[rect.x,rect.y],[rect.x+rect.width,rect.y],[rect.x,rect.y+rect.height],[rect.x+rect.width,rect.y+rect.height]].map(([x,y])=>rotatePoint({x:x*width-width/2,y:y*height-height/2},angle));const xs=points.map(p=>(p.x+size.width/2)/size.width),ys=points.map(p=>(p.y+size.height/2)/size.height);return {x:Math.max(0,Math.min(...xs)),y:Math.max(0,Math.min(...ys)),width:Math.min(1,Math.max(...xs))-Math.max(0,Math.min(...xs)),height:Math.min(1,Math.max(...ys))-Math.max(0,Math.min(...ys))};}

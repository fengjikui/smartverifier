import { rotatePoint, rotatedSize } from './image-editor.ts';
import type { Point, Rect } from './image-editor.ts';
import type { ReferenceRegion, ReferenceTransform } from './admin.ts';

export const regionPoints=(r:Rect&{polygon?:Point[]})=>r.polygon??[{x:r.x,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x+r.width,y:r.y+r.height},{x:r.x,y:r.y+r.height}];
const rounded=(n:number)=>Math.round(n*1e9)/1e9;
export function polygonBounds(points:Point[]):Rect {const xs=points.map(p=>p.x),ys=points.map(p=>p.y);return {x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};}
export function regionGeometryValid(r:ReferenceRegion){
 const p=regionPoints(r),b=polygonBounds(p),cross=p.map((a,i)=>{const c=p[(i+1)%p.length],d=p[(i+2)%p.length];return (c.x-a.x)*(d.y-c.y)-(c.y-a.y)*(d.x-c.x);});
 return p.every(q=>q.x>=0&&q.x<=1&&q.y>=0&&q.y<=1)&&cross.every(n=>n>1e-12)&&(['x','y','width','height'] as const).every(k=>Math.abs(b[k]-r[k])<1e-6);
}
/** 凸多边形分离轴检查。旋转后的外接矩形相交，不等于实际区域重叠。 */
export function regionsOverlap(a:Rect&{polygon?:Point[]},b:Rect&{polygon?:Point[]}){
 const pa=regionPoints(a),pb=regionPoints(b);
 for(const points of [pa,pb])for(let i=0;i<points.length;i++){const p=points[i],q=points[(i+1)%points.length],axis={x:-(q.y-p.y),y:q.x-p.x},project=(v:Point[])=>v.map(n=>n.x*axis.x+n.y*axis.y),xa=project(pa),xb=project(pb);if(Math.max(...xa)<=Math.min(...xb)+1e-12||Math.max(...xb)<=Math.min(...xa)+1e-12)return false;}
 return true;
}
export function transformPoint(p:Point,t:ReferenceTransform,inverse=false):Point {
 if(inverse){const q=rotatePoint({x:p.x*t.width+t.left-t.rotatedWidth/2,y:p.y*t.height+t.top-t.rotatedHeight/2},-t.angle);return {x:(q.x+t.sourceWidth/2)/t.sourceWidth,y:(q.y+t.sourceHeight/2)/t.sourceHeight};}
 const q=rotatePoint({x:p.x*t.sourceWidth-t.sourceWidth/2,y:p.y*t.sourceHeight-t.sourceHeight/2},t.angle);return {x:(q.x+t.rotatedWidth/2-t.left)/t.width,y:(q.y+t.rotatedHeight/2-t.top)/t.height};
}
export function transformRegions(regions:ReferenceRegion[],t:ReferenceTransform,inverse=false):ReferenceRegion[]{return regions.map(r=>{const points=regionPoints(r).map(p=>transformPoint(p,t,inverse));if(points.some(p=>p.x< -1e-6||p.y< -1e-6||p.x>1.000001||p.y>1.000001))throw new Error('裁剪会切掉已标记的区域，请扩大裁剪范围，或先删除不再需要的区域。');const polygon=points.map(p=>({x:rounded(Math.max(0,Math.min(1,p.x))),y:rounded(Math.max(0,Math.min(1,p.y)))}));return {...r,...polygonBounds(polygon),polygon};});}
/** 编辑中使用连续画布坐标预览；服务端保存返回实际整数像素变换。 */
export function previewTransform(width:number,height:number,angle:number,crop?:Rect):ReferenceTransform {const size=rotatedSize(width,height,angle),c=crop??{x:0,y:0,width:1,height:1};return {angle,sourceWidth:width,sourceHeight:height,rotatedWidth:size.width,rotatedHeight:size.height,left:c.x*size.width,top:c.y*size.height,width:c.width*size.width,height:c.height*size.height};}

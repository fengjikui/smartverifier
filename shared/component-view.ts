import type { ComponentResult } from './types';

export interface ImageRect { x:number; y:number; width:number; height:number }
export interface ComponentMarker { id:string; number:string; box:ImageRect; badge:ImageRect; fontSize:number; strokeWidth:number }

/** 仅用于浏览；坐标来自检测结果，不重新定位、不改动照片或模型输入。 */
export function componentBox(bbox:unknown,width:number,height:number):ImageRect|null {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite))return null;
  const [x,y,w,h]=bbox as number[];
  if(x<0||y<0||w<=0||h<=0||x>=1||y>=1||x+w>1.001||y+h>1.001)return null;
  return {x:x*width,y:y*height,width:Math.min(w,1-x)*width,height:Math.min(h,1-y)*height};
}

export function componentNumbers(photos:ReadonlyArray<{components:ReadonlyArray<Pick<ComponentResult,'id'>>}>):Map<string,string> {
  return new Map(photos.flatMap(p=>p.components).map((c,i)=>[c.id,String(i+1).padStart(2,'0')]));
}

/** 等量像素留边；相邻元件贴近时缩短对应侧留白，不切掉当前元件。 */
export function componentFocus(component:Pick<ComponentResult,'id'|'bbox'>,others:Pick<ComponentResult,'id'|'bbox'>[],width:number,height:number):ImageRect {
  const box=componentBox(component.bbox,width,height);
  if(!box)return {x:0,y:0,width,height};
  const pad=Math.max(16,Math.max(box.width,box.height)*.09);
  let left=Math.min(pad,box.x),right=Math.min(pad,width-box.x-box.width),top=Math.min(pad,box.y),bottom=Math.min(pad,height-box.y-box.height);
  for(const c of others){
    if(c.id===component.id)continue;
    const b=componentBox(c.bbox,width,height);if(!b)continue;
    if(b.y<box.y+box.height&&b.y+b.height>box.y){
      if(b.x+b.width<=box.x)left=Math.min(left,(box.x-b.x-b.width)/2);
      if(b.x>=box.x+box.width)right=Math.min(right,(b.x-box.x-box.width)/2);
    }
    if(b.x<box.x+box.width&&b.x+b.width>box.x){
      if(b.y+b.height<=box.y)top=Math.min(top,(box.y-b.y-b.height)/2);
      if(b.y>=box.y+box.height)bottom=Math.min(bottom,(b.y-box.y-box.height)/2);
    }
  }
  return {x:box.x-left,y:box.y-top,width:box.width+left+right,height:box.height+top+bottom};
}

function overlap(a:ImageRect,b:ImageRect):number {
  return Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
}
const clamp=(value:number,max:number)=>Math.max(0,Math.min(value,max));

/** 优先在框外摆编号；边缘/密集场景退到框边，避免居中遮住丝印。 */
export function componentMarkers(components:Pick<ComponentResult,'id'|'bbox'|'index'>[],numbers:Map<string,string>,width:number,height:number,displayScale:number):ComponentMarker[] {
  const scale=Number.isFinite(displayScale)&&displayScale>0?displayScale:1;
  const boxes=components.flatMap(c=>{const box=componentBox(c.bbox,width,height);return box?[{component:c,box}]:[];});
  const placed:ImageRect[]=[];
  return boxes.map(({component:c,box:b})=>{
    const number=numbers.get(c.id)??String(c.index+1).padStart(2,'0');
    const bw=Math.min(width,Math.max(32,number.length*9+14)/scale),bh=Math.min(height,28/scale),gap=4/scale;
    const positions=[
      [b.x,b.y-bh-gap],[b.x+b.width-bw,b.y-bh-gap],
      [b.x,b.y+b.height+gap],[b.x+b.width-bw,b.y+b.height+gap],
      [b.x-bw-gap,b.y],[b.x+b.width+gap,b.y],
      [b.x-bw-gap,b.y+b.height-bh],[b.x+b.width+gap,b.y+b.height-bh],
      [b.x,b.y],[b.x+b.width-bw,b.y],[b.x,b.y+b.height-bh],[b.x+b.width-bw,b.y+b.height-bh],
    ];
    let best:ImageRect={x:0,y:0,width:bw,height:bh},score=Infinity;
    positions.forEach(([x,y],order)=>{
      const r={x:clamp(x,width-bw),y:clamp(y,height-bh),width:bw,height:bh};
      const cost=boxes.reduce((sum,{box})=>sum+overlap(r,box),0)*10+placed.reduce((sum,p)=>sum+overlap(r,p),0)*30+order*.001;
      if(cost<score){best=r;score=cost;}
    });
    placed.push(best);
    return {id:c.id,number,box:b,badge:best,fontSize:13/scale,strokeWidth:1.5/scale};
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory, moveRegion, regionAngle, regionCenter, resizeRegion, rotateRegion } from '../shared/region-editor.ts';
import { polygonBounds, previewTransform, regionGeometryValid, regionPoints, regionsOverlap, transformRegions } from '../shared/reference-geometry.ts';
import { referenceInput } from '../server/admin/registry.ts';
import type { ReferenceRegion } from '../shared/admin.ts';
const size={width:1200,height:700},mark:ReferenceRegion={id:'one',kind:'ignore',x:.25,y:.3,width:.2,height:.2,label:'日期编号'};
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-5,`${a} ≈ ${b}`);

test('旋转使用真实像素坐标，非正方形图片角度正确、中心与四边长度保留；预览和保存接受同一多边形',()=>{
 for(const angle of [27,90,-63,179]){const next=rotateRegion(mark,angle,size)!;assert.ok(next);assert.ok(regionGeometryValid(next));near(regionAngle(next,size),angle);near(regionCenter(next).x,regionCenter(mark).x);near(regionCenter(next).y,regionCenter(mark).y);
  const p=regionPoints(next);near(Math.hypot((p[1].x-p[0].x)*size.width,(p[1].y-p[0].y)*size.height),mark.width*size.width);
  assert.equal(referenceInput.safeParse({material:'TRY',modelNumber:'TEST',status:'draft',regions:[next]}).success,true);
 }
 const edge={...mark,x:0,y:0};assert.equal(rotateRegion(edge,45,size),null);
});

test('移动旋转框会在图片边缘停住，保留原框形状与顺序，不改变输入快照',()=>{
 const rotated=rotateRegion(mark,27,size)!,before=structuredClone(rotated),moved=moveRegion(rotated,{x:100,y:-100}),bounds=polygonBounds(regionPoints(moved));
 near(bounds.x+bounds.width,1);near(bounds.y,0);assert.ok(regionGeometryValid(moved));assert.deepEqual(rotated,before);near(regionAngle(moved,size),27);
 const restored=moveRegion(moved,{x:rotated.x-moved.x,y:rotated.y-moved.y});regionPoints(restored).forEach((p,i)=>{near(p.x,regionPoints(rotated)[i].x);near(p.y,regionPoints(rotated)[i].y);});
});

test('四个角均可缩放：对角固定、旋转角保持，拖过对角时不翻转；越界停在边缘',()=>{
 const rotated=rotateRegion(mark,33,size)!;
 for(let i=0;i<4;i++){const points=regionPoints(rotated),op=points[(i+2)%4],p=points[i],target={x:op.x+(p.x-op.x)*1.4,y:op.y+(p.y-op.y)*1.4},next=resizeRegion(rotated,i,target,size);assert.ok(regionGeometryValid(next));near(regionPoints(next)[(i+2)%4].x,op.x);near(regionPoints(next)[(i+2)%4].y,op.y);near(regionAngle(next,size),33);
  const crossed=resizeRegion(rotated,i,{x:op.x-(p.x-op.x),y:op.y-(p.y-op.y)},size);assert.ok(regionGeometryValid(crossed));const cp=regionPoints(crossed);assert.ok(Math.hypot((cp[1].x-cp[0].x)*size.width,(cp[1].y-cp[0].y)*size.height)>=15.9999);
  const huge=resizeRegion(rotated,i,{x:target.x*100,y:target.y*100},size);assert.ok(regionGeometryValid(huge));assert.ok(regionPoints(huge).every(p=>p.x>=0&&p.y>=0&&p.x<=1&&p.y<=1));
 }
});

test('调整后的区域仍沿用互斥校验与图片裁剪/逆变换，不扩大为外接矩形',()=>{
 const changed=resizeRegion(rotateRegion(mark,27,size)!,2,{x:.55,y:.6},size),focus={...mark,id:'two',kind:'focus' as const,x:.7,y:.7,width:.1,height:.1};
 assert.equal(regionsOverlap(changed,focus),false);assert.equal(referenceInput.safeParse({status:'draft',material:'TRY',regions:[changed,{...changed,id:'bad',kind:'focus'}]}).success,false);
 const t=previewTransform(size.width,size.height,-17),out=transformRegions([changed],t),back=transformRegions(out,t,true);regionPoints(back[0]).forEach((p,i)=>{near(p.x,regionPoints(changed)[i].x);near(p.y,regionPoints(changed)[i].y);});
});

test('文档历史按操作提交：增加/移动/旋转/删除、图片派生和恢复均可回退；新修改截断重做且旧快照不可污染',()=>{
 const original={assetId:'original',marks:[] as ReferenceRegion[],angle:0,crop:null as null|{x:number;y:number;width:number;height:number}},h=new EditHistory(original,10);
 h.commit({...original,marks:[mark]});const moved={...h.value,marks:[moveRegion(mark,{x:.1,y:0})]};h.commit(moved);h.commit({...h.value,marks:[rotateRegion(moved.marks[0],30,size)!]});
 h.commit({...h.value,assetId:'derived',angle:0,crop:{x:.1,y:.1,width:.8,height:.8}});h.commit({...h.value,marks:[]});assert.equal(h.undo().marks.length,1);assert.equal(h.undo().assetId,'original');near(regionAngle(h.value.marks[0],size),30);
 h.undo();assert.deepEqual(h.value,moved);h.redo();near(regionAngle(h.value.marks[0],size),30);assert.equal(h.canRedo,true);
 const branch={...h.value,marks:h.value.marks.map(m=>({...m,label:'新说明'}))};h.commit(branch);branch.marks[0].label='外部改动';assert.equal(h.value.marks[0].label,'新说明');assert.equal(h.canRedo,false);assert.equal(h.commit(structuredClone(h.value)),false);
 while(h.canUndo)h.undo();assert.deepEqual(h.value,original);assert.equal(h.canRedo,true);while(h.canRedo)h.redo();assert.equal(h.value.marks[0].label,'新说明');
 const limited=new EditHistory(0,3);for(let i=1;i<=5;i++)limited.commit(i);for(let i=0;i<5;i++)limited.undo();assert.equal(limited.value,2);
});

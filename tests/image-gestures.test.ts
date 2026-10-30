import test from 'node:test';
import assert from 'node:assert/strict';
import { bindImageWheel, ImagePinch, pinchStart, pinchView } from '../shared/image-gestures.ts';
import { imagePoint } from '../shared/image-editor.ts';
import type { View } from '../shared/image-editor.ts';

test('真实原生wheel绑定围绕事件位置缩放，阻止页面滚动；解绑、停用和零增量不改变图',()=>{
 class Canvas extends EventTarget {getBoundingClientRect(){return {left:30,top:70,width:800,height:600};}}
 const el=new Canvas();let view:View={x:52,y:-24,scale:.5},starts=0,disabled=false;
 const emit=(deltaY:number,deltaMode=0)=>{const e=new Event('wheel',{cancelable:true,bubbles:true});Object.assign(e,{clientX:630,clientY:220,deltaY,deltaMode});el.dispatchEvent(e);return e;};
 const before=imagePoint({x:200,y:-150},view,{width:1600,height:1000});
 const unbind=bindImageWheel(el as unknown as HTMLElement,fn=>{view=fn(view);},()=>starts++,()=>disabled);
 assert.equal(emit(-100).defaultPrevented,true);assert.ok(view.scale>.5);const after=imagePoint({x:200,y:-150},view,{width:1600,height:1000});assert.ok(Math.abs(before.x-after.x)<1e-12);assert.ok(Math.abs(before.y-after.y)<1e-12);
 const scale=view.scale;emit(0);disabled=true;emit(-100);assert.equal(view.scale,scale);assert.equal(starts,1);
 disabled=false;emit(3,1);assert.ok(view.scale<scale);const last=view.scale;unbind();emit(-100);assert.equal(view.scale,last);
});

test('双指以中心缩放并跟随平移，达到倍率上限仍保留锚点',()=>{
 const start=pinchStart({x:40,y:-20,scale:.5},{x:0,y:0},{x:100,y:0});const next=pinchView(start,{x:-50,y:30},{x:150,y:30});assert.equal(next.scale,1);assert.equal(next.x,30);assert.equal(next.y,-10);
 const huge=pinchView(start,{x:-10000,y:0},{x:10000,y:0});assert.equal(huge.scale,16);
});

test('任何编辑模式下双指都接管手势，抬起一指后不会恢复画框，取消后可重新开始',()=>{
 for(const mode of ['move','crop','ignore','focus']){
  const session=new ImagePinch(),view={x:0,y:0,scale:1};assert.equal(session.start(1,{x:0,y:0},view),false,mode);assert.equal(session.start(2,{x:100,y:0},view),true,mode);assert.ok(session.move(2,{x:150,y:0})!.scale>1);assert.equal(session.end(2),true);assert.equal(session.active,true);assert.equal(session.move(1,{x:50,y:10}),null);assert.equal(session.end(1),true);assert.equal(session.active,false);assert.equal(session.start(3,{x:0,y:0},view),false);session.clear();assert.equal(session.points.size,0);
 }
});

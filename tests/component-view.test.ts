import test from 'node:test';
import assert from 'node:assert/strict';
import { componentBox,componentFocus,componentMarkers,componentNumbers } from '../shared/component-view.ts';

const component=(id:string,index:number,bbox:number[])=>({id,index,bbox:bbox as [number,number,number,number]});
const inside=(outer:{x:number;y:number;width:number;height:number},inner:{x:number;y:number;width:number;height:number})=>inner.x>=outer.x-1e-6&&inner.y>=outer.y-1e-6&&inner.x+inner.width<=outer.x+outer.width+1e-6&&inner.y+inner.height<=outer.y+outer.height+1e-6;
test('浏览坐标只接受可靠的归一化范围，允许浮点误差，不猜测坏框',()=>{
 assert.deepEqual(componentBox([.1,.2,.3,.4],1000,800),{x:100,y:160,width:300,height:320});
 for(const value of [null,[],[0,0,0,1],[-.1,0,.2,.2],[1,0,.1,.1],[.9,0,.2,1],[NaN,0,1,1],[0,0,Infinity,1],['0',0,1,1]])assert.equal(componentBox(value,1000,800),null);
 assert.equal(componentBox([0,0,1,1],0,800),null);
 assert.equal(componentBox([0,0,1,1],1000,Infinity),null);
 assert.equal(componentBox([.5,0,.50000001,1],1000,800)!.width,500);
});
test('聚焦保留当前元件及留白，贴近邻件时收缩边距；边缘与整图不越界',()=>{
 const a=component('a',0,[.2,.3,.2,.4]),b=component('b',1,[.41,.3,.2,.4]);
 const focus=componentFocus(a,[a,b],1000,800),box=componentBox(a.bbox,1000,800)!;
 assert.ok(inside(focus,box));assert.ok(focus.x<box.x&&focus.y<box.y);assert.ok(focus.x+focus.width<410,'不把右侧邻件带入视窗');
 for(const bbox of [[0,0,.1,.2],[.9,.8,.1,.2],[0,0,1,1]]){const c=component('c',0,bbox),f=componentFocus(c,[c],1000,800);assert.ok(inside({x:0,y:0,width:1000,height:800},f));assert.ok(inside(f,componentBox(bbox,1000,800)!));}
 assert.deepEqual(componentFocus(component('bad',0,[-1,0,1,1]),[],1000,800),{x:0,y:0,width:1000,height:800});
});
test('编号跨照片连续，与详情导航一致；排序与原始坐标不被浏览逻辑改写',()=>{
 const a=component('a',0,[.1,.2,.2,.4]),b=component('b',1,[.6,.2,.2,.4]),c=component('c',0,[.1,.2,.2,.4]);
 const photos=[{components:[a,b]},{components:[c]}],before=JSON.stringify(photos);
 const numbers=componentNumbers(photos);assert.deepEqual([...numbers.values()],['01','02','03']);
 const markers=componentMarkers([c],numbers,1000,800,.5);assert.equal(markers[0].number,'03');componentFocus(a,[a,b],1000,800);
 assert.equal(JSON.stringify(photos),before);
});
test('常规多元件编号放在框外，密集20件/图边退让到边缘；缩放下字号保持可读',()=>{
 const pair=[component('a',0,[.1,.2,.2,.4]),component('b',1,[.65,.2,.2,.4])];
 for(const scale of [.2,.5,1,4,16]){
  const markers=componentMarkers(pair,new Map([['a','01'],['b','02']]),1536,1024,scale);
  for(const m of markers){assert.equal(m.fontSize*scale,13);assert.ok(Math.abs(m.badge.height*scale-28)<1e-6);assert.ok(m.badge.y+m.badge.height<m.box.y||m.badge.y>m.box.y+m.box.height||m.badge.x+m.badge.width<m.box.x||m.badge.x>m.box.x+m.box.width);}
 }
 const twenty=Array.from({length:20},(_,i)=>component('c'+i,i,[i%5/5,Math.floor(i/5)/4,.2,.25]));
 const markers=componentMarkers(twenty,new Map(),2560,1600,.3);assert.equal(markers.length,20);
 for(const m of markers){assert.ok(inside({x:0,y:0,width:2560,height:1600},m.badge));const center={x:m.box.x+m.box.width/2,y:m.box.y+m.box.height/2};assert.ok(!(center.x>m.badge.x&&center.x<m.badge.x+m.badge.width&&center.y>m.badge.y&&center.y<m.badge.y+m.badge.height),'编号不遮元件中央');}
 assert.deepEqual(componentMarkers([component('bad',0,[9,0,1,1])],new Map(),1000,800,1),[]);
});

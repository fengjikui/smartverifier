import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraPhoto} from '../web/src/camera-media.ts';
const video={} as HTMLVideoElement,track={readyState:'live'} as MediaStreamTrack;
test('连续拍摄的每次曝光都保存独立原始文件，不重编码 ImageCapture 返回值',async()=>{
  let calls=0;const bytes=new Uint8Array([1,2,3,4]);
  class Capture{async takePhoto(){calls++;return new Blob([bytes],{type:'image/png'});}}
  const one=await cameraPhoto(video,track,Capture),two=await cameraPhoto(video,track,Capture);
  assert.equal(calls,2);assert.notEqual(one.file,two.file);assert.deepEqual(new Uint8Array(await one.file.arrayBuffer()),bytes);
  assert.equal(one.file.type,'image/png');assert.equal(one.fromVideo,false);assert.ok(one.file.lastModified>0);
});
test('相机已停止、空文件或过大曝光不能产生可提交照片',async()=>{
  await assert.rejects(()=>cameraPhoto(video,{readyState:'ended'} as MediaStreamTrack),/断开/);
  class Empty{async takePhoto(){return new Blob([]);}}
  await assert.rejects(()=>cameraPhoto(video,track,Empty),/为空/);
  class Large{async takePhoto(){return new Blob([new Uint8Array(20*1024*1024+1)]);}}
  await assert.rejects(()=>cameraPhoto(video,track,Large),/20MB/);
});

test('ImageCapture 一直不返回时限时回退视频帧；画面编码失败可重试，不永久卡住',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');});
 let drawn=0;Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({width:0,height:0,getContext:()=>({drawImage:()=>drawn++}),toBlob:(cb:(v:Blob)=>void)=>cb(new Blob([new Uint8Array([1,2])],{type:'image/jpeg'}))})}});
 class Hanging{takePhoto(){return new Promise<Blob>(()=>{});}}
 const result=await cameraPhoto({readyState:2,videoWidth:640,videoHeight:480} as HTMLVideoElement,track,Hanging,{timeoutMs:5});assert.equal(result.fromVideo,true);assert.equal(drawn,1);assert.equal(result.file.type,'image/jpeg');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({getContext:()=>({drawImage:()=>{}}),toBlob:()=>{}})}});
 await assert.rejects(()=>cameraPhoto({readyState:2,videoWidth:640,videoHeight:480} as HTMLVideoElement,track,undefined,{timeoutMs:5}),/编码超时/);
});

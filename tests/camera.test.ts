import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraPhoto,warmCameraPhoto,releaseCameraPhoto,ThumbnailQueue} from '../web/src/camera-media.ts';
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

test('首张前预热只查能力、不曝光；连续拍摄复用同一ImageCapture，原始字节保持',async()=>{
 let constructors=0,capabilities=0,exposures=0;const live={readyState:'live'} as MediaStreamTrack;
 class Capture{constructor(){constructors++;}async getPhotoCapabilities(){capabilities++;return {};}async takePhoto(){exposures++;return new Blob([new Uint8Array([7,8])],{type:'image/jpeg'});}}
 await warmCameraPhoto(live,Capture);assert.equal(constructors,1);assert.equal(capabilities,1);assert.equal(exposures,0);
 const first=await cameraPhoto(video,live,Capture),second=await cameraPhoto(video,live,Capture);assert.equal(constructors,1);assert.equal(exposures,2);assert.deepEqual(new Uint8Array(await first.file.arrayBuffer()),new Uint8Array([7,8]));assert.equal(second.fromVideo,false);releaseCameraPhoto(live);
});
test('预热失败不影响正常拍摄；缩略图等待不阻塞入队，并串行生成，关闭后不回调',async()=>{
 const live={readyState:'live'} as MediaStreamTrack;class Capture{getPhotoCapabilities(){return new Promise(()=>{});}async takePhoto(){return new Blob([new Uint8Array([1])],{type:'image/jpeg'});}}
 await warmCameraPhoto(live,Capture,5);assert.equal((await cameraPhoto(video,live,Capture)).fromVideo,false);
 let resolve!:(s:string)=>void,renders=0;const completed:string[]=[],queue=new ThumbnailQueue(()=>{renders++;return new Promise(r=>resolve=r);}),file=new File(['test'],'camera.jpg');
 queue.enqueue(file,s=>completed.push(s),()=>assert.fail());queue.enqueue(file,s=>completed.push(s),()=>assert.fail());await Promise.resolve();assert.equal(renders,1);assert.deepEqual(completed,[]);
 resolve('first');await new Promise(r=>setTimeout(r,0));assert.equal(renders,2);assert.deepEqual(completed,['first']);queue.close();resolve('second');await new Promise(r=>setTimeout(r,0));assert.deepEqual(completed,['first']);releaseCameraPhoto(live);
});

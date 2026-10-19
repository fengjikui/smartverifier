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

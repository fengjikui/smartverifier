import { cameraEvent, captureId, deadline } from './camera-diagnostics.ts';
type CaptureDevice={takePhoto:()=>Promise<Blob>;getPhotoCapabilities?:()=>Promise<unknown>};
export type PhotoCapture = new (track:MediaStreamTrack)=>CaptureDevice;
const captures=new WeakMap<MediaStreamTrack,{factory:PhotoCapture;device:CaptureDevice}>();
function captureDevice(track:MediaStreamTrack,factory:PhotoCapture){let entry=captures.get(track);if(!entry||entry.factory!==factory){entry={factory,device:new factory(track)};captures.set(track,entry);}return entry.device;}
export function releaseCameraPhoto(track:MediaStreamTrack){captures.delete(track);}
/** 在取景启动期间初始化一次；只查询能力，不提前曝光、不产生隐藏照片。 */
export async function warmCameraPhoto(track:MediaStreamTrack,capture?:PhotoCapture,timeoutMs=1000){
  const started=performance.now();cameraEvent('still-warmup-start');
  try{if(capture){const device=captureDevice(track,capture);if(device.getPhotoCapabilities)await deadline(device.getPhotoCapabilities(),timeoutMs,'相机能力准备超时');}cameraEvent('still-warmup-complete',{ms:Math.round(performance.now()-started)});}
  catch{cameraEvent('still-warmup-skipped',{ms:Math.round(performance.now()-started),message:'能力预热不可用，保留正常曝光及后备路径'});}
}
/** 缩略图串行后台生成；加入拍摄列表和继续拍照不等待解码。 */
export class ThumbnailQueue{
  private jobs:{file:File;done:(url:string)=>void;failed:()=>void}[]=[];private running=false;private stopped=false;
  constructor(render:(file:File)=>Promise<string>=cameraThumbnail){this.render=render;}
  private render:(file:File)=>Promise<string>;
  enqueue(file:File,done:(url:string)=>void,failed:()=>void){if(this.stopped)return;this.jobs.push({file,done,failed});queueMicrotask(()=>void this.consume());}
  private async consume(){if(this.running||this.stopped)return;this.running=true;try{while(this.jobs.length&&!this.stopped){const job=this.jobs.shift()!;try{const url=await this.render(job.file);if(!this.stopped)job.done(url);}catch{if(!this.stopped)job.failed();}}}finally{this.running=false;}}
  close(){this.stopped=true;this.jobs=[];}
}

export async function cameraPhoto(video:HTMLVideoElement,track:MediaStreamTrack,capture?:PhotoCapture,options:{timeoutMs?:number;captureId?:string}={}):Promise<{file:File;fromVideo:boolean}>{
  if(track.readyState==='ended')throw new Error('相机已断开，请重新打开。');
  let blob:Blob|undefined,fromVideo=false;
  if(capture){try{cameraEvent('still-start',{captureId:options.captureId});const started=performance.now();blob=await deadline(captureDevice(track,capture).takePhoto(),options.timeoutMs??3000,'曝光超时，改用当前视频画面');cameraEvent('still-complete',{bytes:blob.size,captureId:options.captureId,ms:Math.round(performance.now()-started)});}catch{cameraEvent('still-fallback',{captureId:options.captureId,message:'ImageCapture 未完成，使用视频画面保存'});}}
  if(!blob){
    if(video.readyState<2||!video.videoWidth||!video.videoHeight)throw new Error('画面尚未准备好，请稍后再拍。');
    cameraEvent('canvas-start',{captureId:options.captureId,width:video.videoWidth,height:video.videoHeight});const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法保存画面，请使用系统相机。');
    ctx.drawImage(video,0,0);blob=await deadline(new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('照片未保存，请重试。')),'image/jpeg',.96)),options.timeoutMs??5000,'画面编码超时，请改用系统相机。');fromVideo=true;cameraEvent('canvas-complete',{captureId:options.captureId,bytes:blob.size});
  }
  if(!blob.size)throw new Error('照片内容为空，请重新拍摄。');
  if(blob.size>20*1024*1024)throw new Error('单张照片超过20MB，请降低相机照片尺寸后重拍。');
  const extension=blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg',at=Date.now();
  const file=new File([blob],'现场拍摄-'+at+'.'+extension,{type:blob.type||'image/jpeg',lastModified:at});cameraEvent('file-created',{captureId:captureId(file,options.captureId),bytes:file.size,source:fromVideo?'video':'still'});return {file,fromVideo};
}

/** Only the thumbnail is decoded in the strip; full-size originals stay as File blobs. */
export async function cameraThumbnail(file:File,timeoutMs=5000):Promise<string>{
  const url=URL.createObjectURL(file);
  try{
    const image=new Image();await deadline(new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('照片无法预览，请重新拍摄。'));image.src=url;}),timeoutMs,'照片预览超时，请重拍或使用系统相机。');
    const scale=Math.min(1,160/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.8);
  }finally{URL.revokeObjectURL(url);}
}

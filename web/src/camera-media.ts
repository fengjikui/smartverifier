export type PhotoCapture = new (track:MediaStreamTrack)=>{takePhoto:()=>Promise<Blob>};
export async function cameraPhoto(video:HTMLVideoElement,track:MediaStreamTrack,capture?:PhotoCapture):Promise<{file:File;fromVideo:boolean}>{
  if(track.readyState==='ended')throw new Error('相机已断开，请重新打开。');
  let blob:Blob|undefined,fromVideo=false;
  if(capture){try{blob=await new capture(track).takePhoto();}catch{/* Some browsers expose ImageCapture but cannot take still photos. */}}
  if(!blob){
    if(video.readyState<2||!video.videoWidth||!video.videoHeight)throw new Error('画面尚未准备好，请稍后再拍。');
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法保存画面，请使用系统相机。');
    ctx.drawImage(video,0,0);blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('照片未保存，请重试。')),'image/jpeg',.96));fromVideo=true;
  }
  if(!blob.size)throw new Error('照片内容为空，请重新拍摄。');
  if(blob.size>20*1024*1024)throw new Error('单张照片超过20MB，请降低相机照片尺寸后重拍。');
  const extension=blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg',at=Date.now();
  return {file:new File([blob],'现场拍摄-'+at+'.'+extension,{type:blob.type||'image/jpeg',lastModified:at}),fromVideo};
}

/** Only the thumbnail is decoded in the strip; full-size originals stay as File blobs. */
export async function cameraThumbnail(file:File):Promise<string>{
  const url=URL.createObjectURL(file);
  try{
    const image=new Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('照片无法预览，请重新拍摄。'));image.src=url;});
    const scale=Math.min(1,160/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.8);
  }finally{URL.revokeObjectURL(url);}
}

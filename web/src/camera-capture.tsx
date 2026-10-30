import { useEffect, useRef, useState } from 'react';
import { Camera, Check, ChevronLeft, RotateCcw, Trash2 } from 'lucide-react';
import { Btn, Spinner } from './ui';
import { cameraEvent, captureId, deadline, downloadCameraDiagnostics } from './camera-diagnostics';
import { cameraPhoto, warmCameraPhoto, releaseCameraPhoto, ThumbnailQueue } from './camera-media';
import { clientId } from '../../shared/client-id';
import type { PhotoCapture } from './camera-media';
import './camera-capture.css';

type Shot={id:number;file:File;thumbnail:string|null;previewFailed?:boolean};
export function CameraCapture({label,replacing=false,onDone,onCancel}:{label:string;replacing?:boolean;onDone:(files:File[])=>void;onCancel:()=>void}){
  const video=useRef<HTMLVideoElement>(null),native=useRef<HTMLInputElement>(null),stream=useRef<MediaStream|null>(null),alive=useRef(true),taking=useRef(false),counter=useRef(0);
  const thumbnails=useRef<ThumbnailQueue|null>(null);
  const [shots,setShots]=useState<Shot[]>([]),[status,setStatus]=useState<'loading'|'ready'|'fallback'>('loading'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0),[videoCapture,setVideoCapture]=useState(false);
  const limit=replacing?1:50;
  function stop(){stream.current?.getTracks().forEach(track=>{releaseCameraPhoto(track);track.stop();});stream.current=null;}
  useEffect(()=>{thumbnails.current=new ThumbnailQueue();return()=>thumbnails.current?.close();},[]);
  useEffect(()=>{
    alive.current=true;let cancelled=false;
    async function start(){
      setStatus('loading');setError('');setVideoCapture(false);
      if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){setStatus('fallback');setError('当前连接不支持网页连续取景，请使用系统相机拍摄。连续取景需 HTTPS 或本机访问。');return;}
      try{
        cameraEvent('camera-open-start');let expired=false;const media=await deadline(navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:4160},height:{ideal:3120},frameRate:{ideal:15,max:30}}}).then(media=>{if(expired)media.getTracks().forEach(t=>t.stop());return media;}),20000,'打开相机超时，请使用系统相机。').catch(e=>{expired=true;throw e;});
        if(cancelled){media.getTracks().forEach(track=>track.stop());return;}
        stream.current=media;const track=media.getVideoTracks()[0];track.addEventListener('ended',()=>{if(!cancelled){setStatus('fallback');setError('相机已断开，请重新打开或使用系统相机。');}});
        if(video.current){video.current.srcObject=media;await Promise.all([deadline(video.current.play(),10000,'视频取景启动超时，请重试。'),warmCameraPhoto(track,(window as Window&{ImageCapture?:PhotoCapture}).ImageCapture)]);}
        if(!cancelled&&track.readyState==='live'){setStatus('ready');cameraEvent('camera-ready',{width:video.current?.videoWidth,height:video.current?.videoHeight});}
      }catch(e){if(!cancelled){stop();setStatus('fallback');setError((e as DOMException).name==='NotAllowedError'?'未获得相机权限。请在浏览器中允许相机，或使用系统相机拍摄。':'未能打开相机，请检查相机是否被占用，或使用系统相机拍摄。');}}
    }
    const hidden=()=>{if(document.hidden){stop();setStatus('fallback');setError('页面已离开，已暂停相机。返回后可重新打开。');}};document.addEventListener('visibilitychange',hidden);
    void start();return()=>{cancelled=true;alive.current=false;document.removeEventListener('visibilitychange',hidden);stop();};
  },[attempt]);
  async function append(file:File){
    if(!file.size)throw new Error('照片内容为空，请重新拍摄。');
    if(file.size>20*1024*1024)throw new Error('单张照片最多20MB，请重新拍摄。');
    if(shots.reduce((n,s)=>n+s.file.size,0)+file.size>200*1024*1024)throw new Error('本次照片已达200MB，请先完成保存，再继续拍摄。');
    const id=++counter.current,code=captureId(file);setShots(current=>[...current,{id,file,thumbnail:null}]);cameraEvent('shot-added',{captureId:code,bytes:file.size});
    cameraEvent('thumbnail-start',{captureId:code});const at=performance.now();thumbnails.current?.enqueue(file,thumbnail=>{if(alive.current){setShots(current=>current.map(s=>s.id===id?{...s,thumbnail}:s));cameraEvent('thumbnail-complete',{captureId:code,ms:Math.round(performance.now()-at)});}},()=>{if(alive.current){setShots(current=>current.map(s=>s.id===id?{...s,previewFailed:true}:s));cameraEvent('thumbnail-failed',{captureId:code,message:'缩略图失败，原始照片保留，可继续保存'});}});
  }
  async function take(file?:File){
    if(taking.current||shots.length>=limit)return;taking.current=true;setBusy(true);setError('');const code=file?captureId(file):clientId(),at=performance.now();cameraEvent('shutter',{captureId:code,source:shots.length?'repeat':'first'});
    try{
      if(file)await append(file);
      else{
        const track=stream.current?.getVideoTracks()[0];if(!track||!video.current)throw new Error('相机还未准备好，请稍后重试。');
        const capture=(window as Window&{ImageCapture?:PhotoCapture}).ImageCapture;
        const shot=await cameraPhoto(video.current,track,videoCapture?undefined:capture,{captureId:code});if(alive.current){setVideoCapture(shot.fromVideo);await append(shot.file);}
      }
    }catch(e){cameraEvent('capture-failed',{message:(e as Error).message.slice(0,180)});if(alive.current)setError((e as Error).message);}finally{cameraEvent('shutter-finished',{captureId:code,ms:Math.round(performance.now()-at)});taking.current=false;if(alive.current)setBusy(false);}
  }
  return <section className="sv-camera-screen" aria-label={replacing?'重新拍照并替换':'连续拍摄'}>
    <header><Btn tone="quiet" disabled={busy} onClick={()=>{if(shots.length&&!confirm('已拍照片尚未添加，确定放弃本次拍摄？'))return;onCancel();}}><ChevronLeft size={21}/>返回</Btn><div><h1>{replacing?'重新拍摄这张照片':'连续拍摄'}</h1><p>{label}</p></div><span>{shots.length} / {limit} 张</span></header>
    <div className="sv-camera-layout"><div className="sv-camera-view">
      <video ref={video} muted autoPlay playsInline aria-label="相机实时画面" className={status==='fallback'?'is-unavailable':''}/>
      {status!=='ready'?<div className="sv-camera-placeholder">{status==='loading'?<><Spinner/><p>正在打开相机…</p></>:<><Camera size={44}/><h2>使用系统相机拍摄</h2><p>{replacing?'拍清这一张后点击完成，原照片会被替换。':'拍完返回这里，继续拍下一张，最后点击完成。'}</p><Btn onClick={()=>native.current?.click()} disabled={busy||shots.length>=limit}>打开系统相机</Btn><Btn tone="quiet" onClick={()=>setAttempt(n=>n+1)}><RotateCcw size={16}/>重试网页相机</Btn></>}</div>:null}
      {status==='ready'?<p className="sv-camera-guide">对准丝印，保持清晰，拍完一张可直接继续</p>:null}
    </div><aside className="sv-camera-controls">
      <div className="sv-camera-shots" aria-label="本次已拍照片">{shots.length?shots.map((shot,index)=><div className="sv-camera-shot" key={shot.id}>{shot.thumbnail?<img src={shot.thumbnail} alt={'本次照片 '+(index+1)}/>:<div className="sv-camera-preview" role="status">{shot.previewFailed?<Camera size={18}/>:<Spinner/>}<small>{shot.previewFailed?'照片已保留':'预览生成中'}</small></div>}<span>{index+1}</span><button aria-label={'删除本次照片 '+(index+1)} disabled={busy} onClick={()=>setShots(current=>current.filter(s=>s.id!==shot.id))}><Trash2 size={16}/></button></div>):<p>已拍照片会显示在这里</p>}</div>
      <p className="sv-camera-message" role="status">{error|| (shots.length>=limit?'已达到本次拍摄上限，请点击完成。':shots.length?'已拍 '+shots.length+' 张，可继续拍摄或完成。':'一次只需拍清有丝印的一面。')}</p>
      {videoCapture?<small>照片按当前取景分辨率保存；若文字不清晰，请使用系统相机。</small>:null}
      <div className="sv-camera-buttons"><button className="sv-camera-shutter" aria-label="拍摄照片" disabled={status!=='ready'||busy||shots.length>=limit} onClick={()=>void take()}>{busy?<Spinner/>:<Camera size={30}/>}</button><Btn tone="primary" disabled={!shots.length||busy} onClick={()=>{cameraEvent('capture-done',{bytes:shots.reduce((n,s)=>n+s.file.size,0)});stop();onDone(shots.map(s=>s.file));}}><Check size={21}/>完成{shots.length?'（'+shots.length+'张）':''}</Btn></div>
      {status==='ready'?<Btn tone="quiet" disabled={busy||shots.length>=limit} onClick={()=>native.current?.click()}>使用系统相机</Btn>:null}
      <details className="sv-camera-diagnostics"><summary>拍摄遇到问题？</summary><p>诊断只记录处理阶段、尺寸和耗时，不记录图片内容。</p><Btn tone="quiet" onClick={downloadCameraDiagnostics}>导出拍摄诊断</Btn></details>
    </aside></div>
    <input hidden ref={native} type="file" accept="image/*" capture="environment" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void take(file);}}/>
  </section>;
}

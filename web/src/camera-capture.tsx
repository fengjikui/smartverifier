import { useEffect, useRef, useState } from 'react';
import { Camera, Check, ChevronLeft, RotateCcw, Trash2 } from 'lucide-react';
import { Btn, Spinner } from './ui';
import { cameraPhoto, cameraThumbnail } from './camera-media';
import type { PhotoCapture } from './camera-media';
import './camera-capture.css';

type Shot={id:number;file:File;thumbnail:string};
export function CameraCapture({label,replacing=false,onDone,onCancel}:{label:string;replacing?:boolean;onDone:(files:File[])=>void;onCancel:()=>void}){
  const video=useRef<HTMLVideoElement>(null),native=useRef<HTMLInputElement>(null),stream=useRef<MediaStream|null>(null),alive=useRef(true),taking=useRef(false),counter=useRef(0);
  const [shots,setShots]=useState<Shot[]>([]),[status,setStatus]=useState<'loading'|'ready'|'fallback'>('loading'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0),[videoCapture,setVideoCapture]=useState(false);
  const limit=replacing?1:50;
  function stop(){stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;}
  useEffect(()=>{
    alive.current=true;let cancelled=false;
    async function start(){
      setStatus('loading');setError('');
      if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){setStatus('fallback');setError('当前连接不支持网页连续取景，请使用系统相机拍摄。连续取景需 HTTPS 或本机访问。');return;}
      try{
        const media=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:4160},height:{ideal:3120},frameRate:{ideal:15,max:30}}});
        if(cancelled){media.getTracks().forEach(track=>track.stop());return;}
        stream.current=media;const track=media.getVideoTracks()[0];track.addEventListener('ended',()=>{if(!cancelled){setStatus('fallback');setError('相机已断开，请重新打开或使用系统相机。');}});
        if(video.current){video.current.srcObject=media;await video.current.play();}
        if(!cancelled)setStatus('ready');
      }catch(e){if(!cancelled){stop();setStatus('fallback');setError((e as DOMException).name==='NotAllowedError'?'未获得相机权限。请在浏览器中允许相机，或使用系统相机拍摄。':'未能打开相机，请检查相机是否被占用，或使用系统相机拍摄。');}}
    }
    const hidden=()=>{if(document.hidden){stop();setStatus('fallback');setError('页面已离开，已暂停相机。返回后可重新打开。');}};document.addEventListener('visibilitychange',hidden);
    void start();return()=>{cancelled=true;alive.current=false;document.removeEventListener('visibilitychange',hidden);stop();};
  },[attempt]);
  async function append(file:File){
    if(file.size>20*1024*1024)throw new Error('单张照片最多20MB，请重新拍摄。');
    if(shots.reduce((n,s)=>n+s.file.size,0)+file.size>200*1024*1024)throw new Error('本次照片已达200MB，请先完成保存，再继续拍摄。');
    const thumbnail=await cameraThumbnail(file);if(alive.current)setShots(current=>[...current,{id:++counter.current,file,thumbnail}]);
  }
  async function take(file?:File){
    if(taking.current||shots.length>=limit)return;taking.current=true;setBusy(true);setError('');
    try{
      if(file)await append(file);
      else{
        const track=stream.current?.getVideoTracks()[0];if(!track||!video.current)throw new Error('相机还未准备好，请稍后重试。');
        const capture=(window as Window&{ImageCapture?:PhotoCapture}).ImageCapture;
        const shot=await cameraPhoto(video.current,track,capture);if(alive.current){setVideoCapture(shot.fromVideo);await append(shot.file);}
      }
    }catch(e){if(alive.current)setError((e as Error).message);}finally{taking.current=false;if(alive.current)setBusy(false);}
  }
  return <section className="sv-camera-screen" aria-label={replacing?'重新拍照并替换':'连续拍摄'}>
    <header><Btn tone="quiet" disabled={busy} onClick={()=>{if(shots.length&&!confirm('已拍照片尚未添加，确定放弃本次拍摄？'))return;onCancel();}}><ChevronLeft size={21}/>返回</Btn><div><h1>{replacing?'重新拍摄这张照片':'连续拍摄'}</h1><p>{label}</p></div><span>{shots.length} / {limit} 张</span></header>
    <div className="sv-camera-layout"><div className="sv-camera-view">
      <video ref={video} muted autoPlay playsInline aria-label="相机实时画面" className={status==='fallback'?'is-unavailable':''}/>
      {status!=='ready'?<div className="sv-camera-placeholder">{status==='loading'?<><Spinner/><p>正在打开相机…</p></>:<><Camera size={44}/><h2>使用系统相机拍摄</h2><p>{replacing?'拍清这一张后点击完成，原照片会被替换。':'拍完返回这里，继续拍下一张，最后点击完成。'}</p><Btn onClick={()=>native.current?.click()} disabled={busy||shots.length>=limit}>打开系统相机</Btn><Btn tone="quiet" onClick={()=>setAttempt(n=>n+1)}><RotateCcw size={16}/>重试网页相机</Btn></>}</div>:null}
      {status==='ready'?<p className="sv-camera-guide">对准丝印，保持清晰，拍完一张可直接继续</p>:null}
    </div><aside className="sv-camera-controls">
      <div className="sv-camera-shots" aria-label="本次已拍照片">{shots.length?shots.map((shot,index)=><div className="sv-camera-shot" key={shot.id}><img src={shot.thumbnail} alt={'本次照片 '+(index+1)}/><span>{index+1}</span><button aria-label={'删除本次照片 '+(index+1)} disabled={busy} onClick={()=>setShots(current=>current.filter(s=>s.id!==shot.id))}><Trash2 size={16}/></button></div>):<p>已拍照片会显示在这里</p>}</div>
      <p className="sv-camera-message" role="status">{error|| (shots.length>=limit?'已达到本次拍摄上限，请点击完成。':shots.length?'已拍 '+shots.length+' 张，可继续拍摄或完成。':'一次只需拍清有丝印的一面。')}</p>
      {videoCapture?<small>照片按当前取景分辨率保存；若文字不清晰，请使用系统相机。</small>:null}
      <div className="sv-camera-buttons"><button className="sv-camera-shutter" aria-label="拍摄照片" disabled={status!=='ready'||busy||shots.length>=limit} onClick={()=>void take()}>{busy?<Spinner/>:<Camera size={30}/>}</button><Btn tone="primary" disabled={!shots.length||busy} onClick={()=>{stop();onDone(shots.map(s=>s.file));}}><Check size={21}/>完成{shots.length?'（'+shots.length+'张）':''}</Btn></div>
      {status==='ready'?<Btn tone="quiet" disabled={busy||shots.length>=limit} onClick={()=>native.current?.click()}>使用系统相机</Btn>:null}
    </aside></div>
    <input hidden ref={native} type="file" accept="image/*" capture="environment" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void take(file);}}/>
  </section>;
}

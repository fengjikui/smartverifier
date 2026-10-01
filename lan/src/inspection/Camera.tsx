import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

export function CaptureCamera({ onPhoto, onClose, count }: { onPhoto: (file: File) => Promise<void>; onClose: () => void; count: number }) {
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null);
  const [error, setError] = useState(''), [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    const stop = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; setReady(false); };
    const hidden = () => { if (document.hidden) { stop(); setError('相机已暂停。请关闭后重新打开。'); } };
    document.addEventListener('visibilitychange', hidden);
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false }).then(async s => {
      if (disposed) { s.getTracks().forEach(t => t.stop()); return; }
      stream.current = s;
      if (video.current) { video.current.srcObject = s; await video.current.play(); if (!disposed) setReady(true); }
    }).catch(() => { stop(); if (!disposed) setError('相机无法打开。请允许浏览器使用相机，或关闭后选择系统相机 / 相册。'); });
    return () => { disposed = true; stop(); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  async function capture() {
    const element = video.current;
    if (!element || !ready || busy) return;
    setBusy(true); setError('');
    try {
      const canvas = document.createElement('canvas'); canvas.width = element.videoWidth; canvas.height = element.videoHeight;
      canvas.getContext('2d')!.drawImage(element, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('拍照没有完成，请重试。')), 'image/jpeg', .96));
      await onPhoto(new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="iw-camera" aria-label="连续拍摄">
    <div className="iw-camera-head"><span>连续拍摄 · 已保存 {count} 张</span><button onClick={onClose} disabled={busy} aria-label="关闭相机"><X /></button></div>
    <video ref={video} playsInline muted aria-label="实时取景" />
    <div className="iw-camera-foot"><p>{error || '使用纯色背景，器件完整入镜，轻触快门。'}</p><button className="iw-shutter" onClick={() => void capture()} disabled={!ready || busy} aria-label="拍照并保存"><Camera size={30} /></button><span>{busy ? '正在保存，请稍候…' : '拍摄后可继续下一张'}</span></div>
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Camera, X } from 'lucide-react';

export function CaptureCamera({ onPhoto, onClose, onSystem, count, sampleCount, expected, replacement, blocked }: { onPhoto: (file: File) => Promise<void>; onClose: () => void; onSystem: () => void; count: number; sampleCount: number; expected: number; replacement: boolean; blocked: boolean }) {
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
  return <section className="iw-camera" role="dialog" aria-modal="true" aria-label="连续拍摄" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose(); }}>
    <div className="iw-camera-head"><span>{replacement ? '重拍这一张' : '连续拍摄'} · 已保存 {count} 张 · {sampleCount} / {expected} 件</span><button autoFocus onClick={onClose} disabled={busy} aria-label="关闭相机"><X /></button></div>
    <video ref={video} playsInline muted aria-label="实时取景" />
    <div className="iw-camera-foot"><p>{blocked ? '照片尚未保存，请返回照片页重试。' : error || '使用纯色背景，器件完整入镜，文字清晰后拍摄。'}</p><button className="iw-shutter" onClick={() => void capture()} disabled={!ready || busy || blocked} aria-label="拍照并保存"><Camera size={30} /></button><span aria-live="polite">{busy ? '正在保存，请稍候…' : error || blocked ? '返回照片页可处理上传或从相册添加' : '拍摄后可继续下一张'}</span><div className="iw-actions">{error && <button onClick={onSystem} disabled={busy || blocked}>使用系统相机</button>}<button onClick={onClose} disabled={busy}>完成拍摄，查看照片<ArrowRight size={18} /></button></div></div>
  </section>;
}

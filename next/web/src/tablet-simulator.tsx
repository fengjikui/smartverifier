import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpDown, Expand, ExternalLink, Minimize, MousePointer2, RefreshCw, Tablet } from 'lucide-react';
import { installTabletMouseScrolling } from './tablet-mouse';
import './tablet-simulator.css';

export function TabletSimulator() {
  const host = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null);
  const detach = useRef<(() => void) | null>(null);
  const [portrait, setPortrait] = useState(false), [actualSize, setActualSize] = useState(false), [fullscreen, setFullscreen] = useState(false);
  const [available, setAvailable] = useState({width: 0, height: 0}), [error, setError] = useState('');
  const width = portrait ? 840 : 1280, height = portrait ? 1280 : 840;
  const deviceWidth = width + 26, deviceHeight = height + 26;
  const fit = Math.max(.1, Math.min(1, (available.width - 48) / deviceWidth, (available.height - 48) / deviceHeight));
  const scale = actualSize ? 1 : fit;
  const params=new URLSearchParams(location.search);
  const demo=params.get('demo'),requestedTask=params.get('task');
  const explicitTask=requestedTask&&/^[A-Z0-9]{1,100}$/.test(requestedTask)?requestedTask:null;
  const initialTask = demo === 'photos' ? 'DEMO20PHOTOS' : demo === 'board' ? 'DEMO20BOARD' : demo === 'real' ? 'REALVISION2' : explicitTask;
  const initialReport = initialTask && new URLSearchParams(location.search).get('view') === 'report';

  useLayoutEffect(() => {
    const element = stage.current!;
    const measure = () => setAvailable({width: element.clientWidth, height: element.clientHeight});
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    document.title = '观微 · 平板模拟试用';
    const listener = () => setFullscreen(document.fullscreenElement === host.current);
    document.addEventListener('fullscreenchange', listener);
    return () => { document.removeEventListener('fullscreenchange', listener); detach.current?.(); };
  }, []);
  function loaded() {
    detach.current?.();
    const doc = frame.current?.contentDocument;
    if (doc) { detach.current = installTabletMouseScrolling(doc); setError(''); }
    else setError('页面暂时未加载，请点击刷新重试。');
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await host.current?.requestFullscreen();
    } catch { setError('当前浏览器未开启全屏，可将浏览器窗口最大化后继续试用。'); }
  }
  return <div className="sv-simulator" ref={host}>
    <header className="sv-simulator-toolbar">
      <div className="sv-simulator-title"><Tablet size={22} aria-hidden="true"/><div><h1>平板试用</h1><p>HUAWEI MatePad 11.5 S</p></div></div>
      <div className="sv-simulator-controls">
        <div className="sv-simulator-orientation" role="group" aria-label="模拟平板方向">
          <button aria-pressed={!portrait} onClick={()=>setPortrait(false)}>横屏</button>
          <button aria-pressed={portrait} onClick={()=>setPortrait(true)}>竖屏</button>
        </div>
        <button className="sv-simulator-button" aria-pressed={actualSize} onClick={()=>setActualSize(!actualSize)}>{actualSize?'适应窗口':'100% 大小'}</button>
        <button className="sv-simulator-button" onClick={()=>frame.current?.contentWindow?.location.reload()}><RefreshCw size={17}/>刷新</button>
        {document.fullscreenEnabled?<button className="sv-simulator-button" onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize size={17}/>:<Expand size={17}/>}<span>{fullscreen?'退出全屏':'全屏体验'}</span></button>:null}
        <a className="sv-simulator-button" href="/" target="_blank" rel="noopener"><ExternalLink size={17}/><span>普通网页</span></a>
      </div>
    </header>
    <div className="sv-simulator-caption"><span>网页视口 <strong>{width} × {height}</strong><span className="sv-simulator-caption-extra"> · 原型约定尺寸，非屏幕物理像素</span></span><span>{Math.round(scale*100)}% 显示</span></div>
    <main className="sv-simulator-stage" ref={stage} aria-label="平板网页模拟区">
      <div className="sv-simulator-sized" style={{width:deviceWidth*scale,height:deviceHeight*scale}}>
        <div className="sv-simulator-device" style={{width:deviceWidth,height:deviceHeight,transform:`scale(${scale})`}}>
          <iframe ref={frame} src={initialTask?'/?task='+initialTask+(initialReport?'&view=report':''):'/'} title="观微平板检验工作台" width={width} height={height} allow="camera; fullscreen" onLoad={loaded}/>
        </div>
      </div>
    </main>
    <footer className="sv-simulator-help"><span><MousePointer2 size={17}/>单击是点按</span><span><ArrowUpDown size={17}/>按住内容，上下拖动是滑动</span><span className="sv-simulator-help-extra">滚轮也可用 · 输入框可正常打字</span></footer>
    {error?<p className="sv-simulator-error" role="alert">{error}</p>:null}
  </div>;
}

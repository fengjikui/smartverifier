import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Check, Move, RotateCcw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { defaultViewport, type Photo, type Viewport } from "./api";
import { anchoredZoom, aspectRatio, clamp, fitFrame, normalizeAngle, placement, reshapeView, resizeFreeFrame } from "./geometry.mjs";

type Point = { x: number; y: number };
type ResizeEdge = "right" | "bottom" | "bottom-right";
type Props = { photo: Photo; value: Viewport; busy: boolean; onChange: (value: Viewport) => void; onCancel: () => void; onApply: () => void };

export function ViewportEditor({ photo, value, busy, onChange, onCancel, onApply }: Props) {
  const frame = useRef<HTMLDivElement>(null), pointers = useRef(new Map<number, Point>());
  const stage = useRef<HTMLDivElement>(null);
  const resizing = useRef<{ id: number; edge: ResizeEdge; x: number; y: number; width: number; height: number; bounds: { width: number; height: number }; view: Viewport } | null>(null);
  const current = useRef(value), change = useRef(onChange);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 }), [freeScale, setFreeScale] = useState(1);
  const free = value.aspect === "free", ratio = aspectRatio(value);
  const bounds = { width: Math.max(1, stageSize.width - 44), height: Math.max(1, stageSize.height - 44) };
  const fitted = fitFrame(bounds, ratio);
  const freeFrameSize = useRef({ width: 1, height: 1 });
  freeFrameSize.current = { width: fitted.width * freeScale, height: fitted.height * freeScale };
  current.current = value; change.current = onChange;
  const update = (next: Viewport) => { current.current = next; change.current(next); };
  useEffect(() => {
    const element = frame.current!;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    const stageObserver = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    stageObserver.observe(stage.current!);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect(), anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const next = anchoredZoom(current.current, rect, anchor, anchor, current.current.zoom * Math.exp(-event.deltaY * .002));
      current.current = next; change.current(next);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); stageObserver.disconnect(); element.removeEventListener("wheel", wheel); };
  }, []);
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId) || busy) return;
    const before = [...pointers.current.values()];
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = [...pointers.current.values()], rect = event.currentTarget.getBoundingClientRect();
    const center = (points: Point[]) => ({ x: points.reduce((sum, p) => sum + p.x, 0) / points.length - rect.left, y: points.reduce((sum, p) => sum + p.y, 0) / points.length - rect.top });
    const distance = (points: Point[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const factor = before.length === 2 && distance(before) > 2 ? distance(after) / distance(before) : 1;
    update(anchoredZoom(current.current, rect, center(before), center(after), current.current.zoom * factor));
  }
  function resize(edge: ResizeEdge, dx: number, dy: number, start = { ...freeFrameSize.current, bounds, view: current.current }) {
    const next = resizeFreeFrame(start, start.bounds, edge, dx, dy);
    freeFrameSize.current = { width: next.width, height: next.height };
    setFreeScale(next.scale);
    update(reshapeView(photo, start, start.view, next));
  }
  const positioned = placement(photo, size, value);
  return <div className="editor" aria-busy={busy}>
    <p className="gesture-hint"><Move size={14}/>{free ? "拉边角调宽高 · 框内拖动、双指缩放" : "单指拖动 · 双指缩放 · 下方旋转"}</p>
    <div ref={stage} className={free ? "viewport-stage free-stage" : "viewport-stage"}>
    <div className={free ? "free-frame-shell" : "fixed-frame-shell"} style={free ? { width: fitted.width * freeScale, height: fitted.height * freeScale } : undefined}>
    <div ref={frame} className="viewport-frame" tabIndex={0} role="group" aria-label="照片取景框，可拖动图片、双指缩放，也可用方向键移动"
      style={free ? { width: "100%", height: "100%" } : { aspectRatio: ratio, maxWidth: `min(100%, ${56 * ratio}dvh)` }}
      onPointerDown={event => {
        if (busy || pointers.current.size >= 2) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }} onPointerMove={pointerMove}
      onPointerUp={event => pointers.current.delete(event.pointerId)} onPointerCancel={event => pointers.current.delete(event.pointerId)} onLostPointerCapture={event => pointers.current.delete(event.pointerId)}
      onKeyDown={event => {
        const delta: Record<string, [number, number]> = { ArrowLeft: [-.025, 0], ArrowRight: [.025, 0], ArrowUp: [0, -.025], ArrowDown: [0, .025] };
        if (delta[event.key] && !busy) { event.preventDefault(); const [dx, dy] = delta[event.key]; update({ ...value, pan_x: clamp(value.pan_x + dx, -12, 12), pan_y: clamp(value.pan_y + dy, -12, 12) }); }
      }}>
      <img draggable={false} src={photo.preview_url} alt="正在调整的原照片" style={{ width: positioned.width, height: positioned.height, left: positioned.x, top: positioned.y, transform: `translate(-50%, -50%) rotate(${value.rotation}deg)` }}/>
      <div className="crop-grid"/>
    </div>
    {free && (["right", "bottom", "bottom-right"] as const).map(edge => <button key={edge} type="button" className={`frame-handle handle-${edge}`} disabled={busy}
      aria-label={edge === "right" ? "调整取景框宽度" : edge === "bottom" ? "调整取景框高度" : "自由调整取景框宽高"}
      onPointerDown={event => {
        if (resizing.current || busy) return;
        event.preventDefault(); event.stopPropagation(); pointers.current.clear();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizing.current = { id: event.pointerId, edge, x: event.clientX, y: event.clientY, ...size, bounds, view: current.current };
      }} onPointerMove={event => {
        const start = resizing.current;
        if (!start || start.id !== event.pointerId) return;
        event.stopPropagation(); resize(start.edge, event.clientX - start.x, event.clientY - start.y, start);
      }} onPointerUp={() => { resizing.current = null; }} onPointerCancel={() => { resizing.current = null; }} onLostPointerCapture={() => { resizing.current = null; }}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        resize(edge, event.key === "ArrowLeft" ? -4 : event.key === "ArrowRight" ? 4 : 0, event.key === "ArrowUp" ? -4 : event.key === "ArrowDown" ? 4 : 0);
      }}><span/></button>)}
    </div>
    </div>
    <div className="editor-toolbar"><div className="aspect-options" role="group" aria-label="取景框比例">{(["1:1", "4:3", "3:4", "free"] as const).map(aspect => <button key={aspect} aria-pressed={value.aspect === aspect} disabled={busy} onClick={() => { setFreeScale(1); update({ ...value, aspect, aspect_ratio: aspect === "free" ? ratio : undefined }); }}>{aspect === "free" ? "自由" : aspect}</button>)}</div><button className="reset-view" disabled={busy} onClick={() => { setFreeScale(1); update({ ...defaultViewport, mode: "crop" }); }}>重置</button></div>
    {free && <p className="free-ratio-readout" aria-live="polite">当前宽高比 <strong>{ratio.toFixed(2)} : 1</strong></p>}
    <label className="slider-label" id="zoom-label">放大倍率 <span>{value.zoom.toFixed(1)}×</span></label>
    <Slider min={1} max={12} step={.05} value={[value.zoom]} disabled={busy} aria-labelledby="zoom-label" onValueChange={([zoom]) => update({ ...value, zoom })}/>
    <label className="slider-label" id="rotation-label">旋转角度 <span>{Math.round(value.rotation)}°</span></label>
    <Slider min={-180} max={180} step={1} value={[value.rotation]} disabled={busy} aria-labelledby="rotation-label" onValueChange={([rotation]) => update({ ...value, rotation })}/>
    <div className="rotation-buttons"><Button variant="ghost" disabled={busy} onClick={() => update({ ...value, rotation: normalizeAngle(value.rotation - 90) })}><RotateCcw size={17}/> 左转 90°</Button><Button variant="ghost" disabled={busy} onClick={() => update({ ...value, rotation: normalizeAngle(value.rotation + 90) })}><RotateCw size={17}/> 右转 90°</Button></div>
    <p className="editor-note">只发送框内内容。确认后可查看实际图片。</p>
    <div className="editor-actions"><Button variant="outline" className="secondary" onClick={onCancel} disabled={busy}>取消</Button><Button className="primary" onClick={onApply} disabled={busy}><Check size={18}/> 使用这个范围</Button></div>
  </div>;
}

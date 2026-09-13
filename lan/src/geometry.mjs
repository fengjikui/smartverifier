// Shared editor geometry uses viewport-relative offsets, independent of screen size.
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const normalizeAngle = angle => ((angle + 180) % 360 + 360) % 360 - 180;

export function aspectRatio(view) {
  if (view.aspect === "free") return clamp(view.aspect_ratio ?? 1, .125, 8);
  const [width, height] = view.aspect.split(":").map(Number);
  return width / height;
}

export function fitFrame(bounds, ratio) {
  const width = Math.min(bounds.width, bounds.height * ratio);
  return { width, height: width / ratio };
}

// The frame is centered: each edge follows the pointer at twice its delta.
export function resizeFreeFrame(start, bounds, edge, dx, dy) {
  let width = clamp(start.width + (edge.includes("right") ? dx * 2 : 0), Math.min(56, bounds.width), bounds.width);
  let height = clamp(start.height + (edge.includes("bottom") ? dy * 2 : 0), Math.min(56, bounds.height), bounds.height);
  if (width / height > 8) height = width / 8;
  if (width / height < .125) width = height / 8;
  const ratio = width / height;
  return { width, height, ratio, scale: width / fitFrame(bounds, ratio).width };
}

// Keep the photograph anchored in the stage when the centered crop frame changes.
export function reshapeView(source, before, view, after) {
  const oldScale = Math.max(before.width / source.width, before.height / source.height) * view.zoom;
  const newBase = Math.max(after.width / source.width, after.height / source.height);
  return { ...view, aspect: "free", aspect_ratio: after.ratio,
    zoom: clamp(oldScale / newBase, 1, 12),
    pan_x: clamp(view.pan_x * before.width / after.width, -12, 12),
    pan_y: clamp(view.pan_y * before.height / after.height, -12, 12) };
}

export function placement(source, frame, view) {
  const scale = Math.max(frame.width / source.width, frame.height / source.height) * view.zoom;
  return { width: source.width * scale, height: source.height * scale,
    x: frame.width * (.5 + view.pan_x), y: frame.height * (.5 + view.pan_y) };
}

// Keep the image point under a pinch/wheel anchor fixed while scaling and moving.
export function anchoredZoom(view, frame, oldAnchor, newAnchor, requestedZoom) {
  const zoom = clamp(requestedZoom, 1, 12), factor = zoom / view.zoom;
  const x = newAnchor.x + factor * (frame.width * (.5 + view.pan_x) - oldAnchor.x);
  const y = newAnchor.y + factor * (frame.height * (.5 + view.pan_y) - oldAnchor.y);
  return { ...view, zoom, pan_x: clamp(x / frame.width - .5, -12, 12), pan_y: clamp(y / frame.height - .5, -12, 12) };
}

export function sourcePoint(source, frame, view, point) {
  const p = placement(source, frame, view), scale = p.width / source.width;
  const angle = view.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return { x: source.width / 2 + (c * (point.x - p.x) + s * (point.y - p.y)) / scale,
    y: source.height / 2 + (-s * (point.x - p.x) + c * (point.y - p.y)) / scale };
}

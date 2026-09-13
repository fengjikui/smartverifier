import test from "node:test";
import assert from "node:assert/strict";
import { anchoredZoom, aspectRatio, fitFrame, placement, reshapeView, resizeFreeFrame, sourcePoint, normalizeAngle } from "./geometry.mjs";
const view = { zoom: 1, rotation: 0, pan_x: 0, pan_y: 0 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("a non-square original covers the viewport and maps its center exactly", () => {
  const source = { width: 4000, height: 3000 }, frame = { width: 360, height: 360 };
  assert.deepEqual(placement(source, frame, view), { width: 480, height: 360, x: 180, y: 180 });
  assert.deepEqual(sourcePoint(source, frame, view, { x: 180, y: 180 }), { x: 2000, y: 1500 });
});
test("pinch preserves the source point below moving fingers even after rotation", () => {
  const source = { width: 2000, height: 3000 }, frame = { width: 360, height: 480 };
  const before = { ...view, zoom: 2, rotation: 37, pan_x: .2, pan_y: -.1 };
  const oldAnchor = { x: 80, y: 130 }, newAnchor = { x: 120, y: 160 };
  const after = anchoredZoom(before, frame, oldAnchor, newAnchor, 3.5);
  const p = sourcePoint(source, frame, before, oldAnchor), q = sourcePoint(source, frame, after, newAnchor);
  near(p.x, q.x); near(p.y, q.y);
});
test("zoom cap uses actual factor and continues panning", () => {
  const after = anchoredZoom({ ...view, zoom: 12 }, { width: 400, height: 400 }, { x: 200, y: 200 }, { x: 220, y: 180 }, 30);
  assert.equal(after.zoom, 12); near(after.pan_x, .05); near(after.pan_y, -.05);
});
test("phone and server resolution map the same fractional viewport to original pixels", () => {
  const source = { width: 2686, height: 3585 }, v = { ...view, zoom: 4.7, rotation: -73, pan_x: .2, pan_y: -.5 };
  const phone = sourcePoint(source, { width: 360, height: 270 }, v, { x: 90, y: 189 });
  const output = sourcePoint(source, { width: 1280, height: 960 }, v, { x: 320, y: 672 });
  near(phone.x, output.x); near(phone.y, output.y);
});
test("quarter turns wrap into the fine rotation slider range", () => {
  assert.equal(normalizeAngle(270), -90); assert.equal(normalizeAngle(-270), 90); assert.equal(normalizeAngle(360), 0);
});

test("自由比例的边框独立调整宽高，并能从比例还原实际框尺寸", () => {
  const bounds = { width: 350, height: 410 }, start = { width: 300, height: 300 };
  const next = resizeFreeFrame(start, bounds, "bottom", 200, -90);
  assert.equal(next.width, 300); assert.equal(next.height, 120); assert.equal(next.ratio, 2.5);
  const fitted = fitFrame(bounds, next.ratio);
  near(fitted.width * next.scale, next.width); near(fitted.height * next.scale, next.height);
  assert.equal(aspectRatio({ aspect: "free", aspect_ratio: next.ratio }), 2.5);
});

test("自由比例角拖动不会越出手机画布，极窄框仍能继续操作", () => {
  const bounds = { width: 350, height: 410 }, start = { width: 300, height: 300 };
  for (const [dx, dy] of [[900, -900], [-900, 900], [900, 900], [-900, -900]]) {
    const next = resizeFreeFrame(start, bounds, "bottom-right", dx, dy);
    assert.ok(next.width <= bounds.width && next.height <= bounds.height);
    assert.ok(next.width >= 56 && next.height >= 56);
    assert.ok(next.ratio >= .125 && next.ratio <= 8);
  }
});

test("调整框形状时保持同一细节居中，保留照片的尺寸和旋转", () => {
  const source = { width: 800, height: 400 }, before = { width: 300, height: 200 };
  const v = { ...view, zoom: 2, rotation: 27, pan_x: .5, pan_y: -.1 };
  const after = { width: 180, height: 150, ratio: 1.2 };
  const next = reshapeView(source, before, v, after);
  const oldPoint = sourcePoint(source, before, v, { x: before.width / 2, y: before.height / 2 });
  const newPoint = sourcePoint(source, after, next, { x: after.width / 2, y: after.height / 2 });
  near(oldPoint.x, newPoint.x); near(oldPoint.y, newPoint.y);
  near(placement(source, before, v).width, placement(source, after, next).width);
  assert.equal(next.rotation, 27);
});

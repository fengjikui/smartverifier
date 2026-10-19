/** 仅在电脑平板预览中安装。真实触摸、输入框和普通网页均沿用浏览器行为。 */
export function installTabletMouseScrolling(doc: Document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  let gesture: { pointer: number; x: number; y: number; lastY: number; element: HTMLElement; chain: HTMLElement[]; dragging: boolean } | null = null;
  let suppressClick = false;
  const style = doc.createElement('style');
  style.textContent = `
    html.sv-tablet-mouse { user-select: none; -webkit-user-select: none; }
    html.sv-tablet-mouse input, html.sv-tablet-mouse textarea, html.sv-tablet-mouse [contenteditable="true"] { user-select: text; -webkit-user-select: text; }
    html.sv-tablet-dragging, html.sv-tablet-dragging * { cursor: grabbing !important; }
  `;
  doc.head.append(style);
  doc.documentElement.classList.add('sv-tablet-mouse');

  function scrollables(start: HTMLElement): HTMLElement[] {
    const chain: HTMLElement[] = [];
    for (let element: HTMLElement | null = start; element; element = element.parentElement) {
      const css = view!.getComputedStyle(element);
      if (/(auto|scroll)/.test(css.overflowY) && element.scrollHeight > element.clientHeight + 1) {
        chain.push(element);
        if (css.overscrollBehaviorY === 'contain' || css.overscrollBehaviorY === 'none') return chain;
      }
    }
    const root = doc.scrollingElement as HTMLElement | null;
    if (root && root.scrollHeight > root.clientHeight + 1 && !chain.includes(root)) chain.push(root);
    return chain;
  }
  function finish() {
    if (gesture?.dragging) suppressClick = true;
    const active = gesture;
    gesture = null;
    doc.documentElement.classList.remove('sv-tablet-dragging');
    try { if (active?.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer); } catch { /* The element may have unmounted. */ }
  }
  function down(event: PointerEvent) {
    finish(); suppressClick = false;
    if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest || target.closest('input,textarea,select,[contenteditable="true"],[role="slider"],[data-native-mouse]')) return;
    const chain = scrollables(target), element = chain[0];
    if (!element) return;
    // 保留系统滚动条的原生拖动能力。
    if (target === element && event.clientX >= element.getBoundingClientRect().left + element.clientWidth) return;
    gesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY, lastY: event.clientY, element, chain, dragging: false };
  }
  function move(event: PointerEvent) {
    const current = gesture;
    if (!current || current.pointer !== event.pointerId) return;
    if (!(event.buttons & 1)) { finish(); return; }
    const dy = event.clientY - current.y;
    if (!current.dragging && Math.hypot(event.clientX - current.x, dy) < 8) return;
    if (!current.dragging) {
      current.dragging = true;
      doc.getSelection()?.removeAllRanges();
      doc.documentElement.classList.add('sv-tablet-dragging');
      try { current.element.setPointerCapture(event.pointerId); } catch { /* Capture is optional; document listeners still handle movement. */ }
    }
    event.preventDefault(); event.stopImmediatePropagation();
    // 手指向上拖，内容向上走；内层到边缘后将剩余位移交给外层，横向不滚动。
    let remaining = current.lastY - event.clientY;
    current.lastY = event.clientY;
    for (const element of current.chain) {
      const before = element.scrollTop;
      element.scrollTop += remaining;
      remaining -= element.scrollTop - before;
      if (Math.abs(remaining) < .5) break;
    }
  }
  function up(event: PointerEvent) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (gesture.dragging) { event.preventDefault(); event.stopImmediatePropagation(); }
    finish();
  }
  function click(event: MouseEvent) {
    if (suppressClick && event.detail > 0) {
      suppressClick = false;
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }
  function nativeDrag(event: DragEvent) { event.preventDefault(); }
  doc.addEventListener('pointerdown', down, true);
  doc.addEventListener('pointermove', move, { capture: true, passive: false });
  doc.addEventListener('pointerup', up, true);
  doc.addEventListener('pointercancel', up, true);
  doc.addEventListener('lostpointercapture', finish, true);
  doc.addEventListener('click', click, true);
  doc.addEventListener('dragstart', nativeDrag, true);
  view.addEventListener('blur', finish);
  return () => {
    finish();
    doc.removeEventListener('pointerdown', down, true);
    doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerup', up, true);
    doc.removeEventListener('pointercancel', up, true);
    doc.removeEventListener('lostpointercapture', finish, true);
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('dragstart', nativeDrag, true);
    view.removeEventListener('blur', finish);
    doc.documentElement.classList.remove('sv-tablet-mouse', 'sv-tablet-dragging');
    style.remove();
  };
}

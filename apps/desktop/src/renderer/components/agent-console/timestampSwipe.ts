/** Wide enough for localized times and the gap beside tool rows. */
export const TIMESTAMP_REVEAL_PX = 112;
/** Wheel events have no finger-up signal. Allow brief pauses before settling. */
export const WHEEL_RELEASE_MS = 450;

/** Renderer-only gesture. Pointer drags settle on release, never on an idle timer. */
export function attachTimestampSwipe(el: HTMLElement) {
  let reveal = 0;
  let pointer: { id: number; x: number; y: number; active: boolean } | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  // The list is found once per gesture. The offset is written straight to its
  // transform and the times are shown by one class: inherited custom
  // properties on the scroller made every move restyle every mounted row.
  let list: HTMLElement | null = null;
  const paint = (px: number, settling = false) => {
    list ??= el.querySelector<HTMLElement>('.vt-list');
    // Only while moved: a transform at rest would trap fixed popovers in rows.
    if (list) list.style.transform = px > 0 || settling ? `translateX(${-px}px)` : '';
    el.classList.toggle('vt-stamps-on', px >= TIMESTAMP_REVEAL_PX / 2);
    el.classList.toggle('vt-revealing', px > 0 || settling);
    if (px === 0 && !settling) list = null;
  };
  const move = (px: number) => {
    clearTimeout(release);
    clearTimeout(settle);
    el.classList.add('vt-swiping');
    reveal = Math.min(TIMESTAMP_REVEAL_PX, Math.max(0, px));
    paint(reveal);
  };
  const finish = () => {
    clearTimeout(release);
    el.classList.remove('vt-swiping');
    reveal = 0;
    paint(0, true);
    settle = setTimeout(() => paint(0), 250);
  };
  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || e.ctrlKey) return;
    e.preventDefault();
    move(reveal + Math.abs(e.deltaX));
    if (!pointer?.active) release = setTimeout(finish, WHEEL_RELEASE_MS);
  };
  const onDown = (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0) return;
    // Keep buttons, links, editors and selectable message text working normally.
    if ((e.target as Element).closest('button, a, input, textarea, select, [contenteditable="true"], pre')) return;
    pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, active: false };
  };
  const onMove = (e: PointerEvent) => {
    if (!pointer || pointer.id !== e.pointerId) return;
    const dx = pointer.x - e.clientX;
    const dy = pointer.y - e.clientY;
    if (!pointer.active) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { pointer = undefined; return; }
      if (dx < 8 || dx <= Math.abs(dy)) return;
      pointer.active = true;
      el.setPointerCapture(e.pointerId);
      window.getSelection()?.removeAllRanges();
    }
    e.preventDefault();
    move(dx);
  };
  const onUp = (e: PointerEvent) => {
    if (!pointer || pointer.id !== e.pointerId) return;
    const active = pointer.active;
    pointer = undefined;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (active) finish();
  };
  const onBlur = () => { pointer = undefined; if (reveal) finish(); };
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', onUp);
  window.addEventListener('blur', onBlur);
  return () => {
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('lostpointercapture', onUp);
    window.removeEventListener('blur', onBlur);
    clearTimeout(release);
    clearTimeout(settle);
    pointer = undefined;
    el.classList.remove('vt-swiping');
    paint(0);
  };
}

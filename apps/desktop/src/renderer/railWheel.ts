import type { WheelEvent } from 'react';

/** Pixels per wheel line, for a wheel that reports lines (Firefox, some mice). */
const LINE_PX = 16;

/** Whether `el` itself can still scroll `dy` pixels in that direction. */
function canScroll(el: HTMLElement, dy: number): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const overflow = getComputedStyle(el).overflowY;
  if (overflow !== 'auto' && overflow !== 'scroll') return false;
  return dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
}

/**
 * A page with a side menu (Settings, Models, Automations) scrolls only its
 * content column, so a wheel over the menu or the gutters used to do nothing.
 * Put this on the layout that holds both: a wheel that lands outside the
 * content column scrolls the content, unless something under the pointer (a
 * long menu) can still scroll that way itself.
 */
export function forwardWheelToContent(event: WheelEvent<HTMLElement>, content: HTMLElement | null): void {
  if (!content || event.ctrlKey || event.defaultPrevented) return;
  const target = event.target as Node;
  if (content.contains(target)) return;
  const dy = event.deltaY * (event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? content.clientHeight : 1);
  if (!dy) return;
  for (let el: HTMLElement | null = target.nodeType === 1 ? (target as HTMLElement) : target.parentElement; el && el !== event.currentTarget; el = el.parentElement) {
    if (canScroll(el, dy)) return;
  }
  content.scrollTop += dy;
}

import React, { useLayoutEffect, useRef } from 'react';
type AgentPanelOrientation = 'vertical' | 'horizontal';
import { PanelLeftIcon, PanelSwapIcon } from '../icons.js';
import { HoverTip } from './HoverTip.js';

/**
 * The Agents panel's own show/hide and column/row controls. They stay in the
 * panel's corner whether the panel is open or collapsed, so the way back is
 * where the panel was rather than up in the title bar.
 *
 * Each is an icon button; what it does shows in a hover tooltip, so the button
 * never changes size under the pointer. Switching orientation moves the buttons between a stack and a row; the move
 * animates from where each button was (FLIP), so they slide into place
 * instead of jumping.
 */
export function AgentPanelControls({ show, orientation, onToggle, onOrientation, extra }: {
  show: boolean;
  orientation: AgentPanelOrientation;
  onToggle: () => void;
  onOrientation: (next: AgentPanelOrientation) => void;
  /** Panel-only actions (the + menu) that follow the same layout. */
  extra?: React.ReactNode;
}) {
  const horizontal = orientation === 'horizontal';
  // A row panel keeps its controls in a narrow column at its left; a column
  // panel keeps them in a row across its top. Collapsed, they hold the same
  // place: a strip down the wall's left, or a row above it.
  const stacked = show ? horizontal : !horizontal;
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<Map<Element, DOMRect>>(new Map());

  // FLIP: remember each button's box, and when the layout flips, start each
  // one where it was and let it travel to where it now is.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = [...root.children];
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    for (const el of items) {
      const before = last.current.get(el);
      const after = el.getBoundingClientRect();
      if (!before || reduce || !(el instanceof HTMLElement) || typeof el.animate !== 'function') continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
    last.current = new Map(items.map((el) => [el, el.getBoundingClientRect()]));
  }, [stacked]);

  const orientationLabel = horizontal ? 'Show agents in a column' : 'Show agents in a row';
  // Stacked controls sit against the wall's left edge: their tips open to the right.
  const tipSide = stacked ? 'right' : 'bottom';
  return (
    <div ref={ref} className="agent-panel-controls" data-stacked={stacked || undefined} data-collapsed={!show || undefined}>
      <HoverTip label={show ? 'Hide agents' : 'Show agents'} side={tipSide}>
        <button
          type="button"
          className="agent-panel-pill"
          aria-label={show ? 'Hide the agent panel' : 'Show the agent panel'}
          aria-pressed={show}
          onClick={onToggle}
        >
          <PanelLeftIcon className="h-4 w-4 shrink-0" />
        </button>
      </HoverTip>
      <HoverTip label={orientationLabel} side={tipSide}>
        <button
          type="button"
          className="agent-panel-pill"
          aria-label={orientationLabel}
          onClick={() => onOrientation(horizontal ? 'vertical' : 'horizontal')}
        >
          <PanelSwapIcon className="h-4 w-4 shrink-0" />
        </button>
      </HoverTip>
      {extra}
    </div>
  );
}

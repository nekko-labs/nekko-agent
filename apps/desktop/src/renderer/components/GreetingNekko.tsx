import React, { useEffect, useRef, useState } from 'react';

/** A bounded glance keeps both pixel eyes inside the face. */
export function greetingGaze(dx: number, dy: number) {
  const distance = Math.hypot(dx, dy);
  const scale = distance ? Math.min(1, distance / 120) / distance : 0;
  return { x: Math.round(dx * scale * 2 * 10) / 10, y: Math.round(dy * scale * 2 * 10) / 10 };
}

/**
 * Where the caret is drawn. Chromium often reports no rect for a collapsed
 * range at the end of a text node (the usual spot while typing), so measure
 * the character just before the caret and take its right edge instead.
 */
function caretRect(node: Node, offset: number): { left: number; top: number } | null {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const direct = range.getClientRects()[0];
  if (direct) return direct;
  if (node.nodeType === Node.TEXT_NODE && offset > 0) {
    range.setStart(node, offset - 1);
    const before = range.getClientRects();
    const last = before[before.length - 1];
    if (last) return { left: last.right, top: last.top };
  }
  return null;
}

/**
 * Points the peeking cat's eyes at the caret of the composer it hangs over:
 * a bounded, animation-frame-throttled read of `document.getSelection()`
 * scoped to the nearest `.composer-section`. With `restOnComposer`, a missing
 * caret sends the gaze to the composer's centre instead of keeping a stale one.
 */
export function useComposerGaze(ref: React.RefObject<SVGSVGElement | null>, { restOnComposer = false, deps = [] as unknown[] } = {}) {
  const [look, setLook] = useState({ x: 0, y: 1 });
  useEffect(() => {
    const svg = ref.current;
    const composer = svg?.closest('.composer-section');
    if (!svg || !composer) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const selection = document.getSelection();
        const editor = composer.querySelector('[contenteditable], textarea');
        if (!editor) return;
        let target: DOMRect | null = null;
        if (selection?.focusNode && editor.contains(selection.focusNode) && selection.rangeCount) {
          const caret = caretRect(selection.focusNode, selection.focusOffset);
          target = caret ? new DOMRect(caret.left, caret.top, 0, 0) : editor.getBoundingClientRect();
        } else if (restOnComposer) {
          const box = editor.getBoundingClientRect();
          target = new DOMRect(box.left + box.width / 2, box.top + box.height / 2, 0, 0);
        }
        if (!target) return;
        const face = svg.getBoundingClientRect();
        setLook(greetingGaze(target.left - (face.left + face.width / 2), target.top - (face.top + face.height / 2)));
      });
    };
    update();
    document.addEventListener('selectionchange', update);
    composer.addEventListener('input', update);
    composer.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    // The composer grows, shrinks and settles after mount (entrance, resize
    // grip, a plan sheet appearing), which moves the resting target.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resized?.observe(composer);
    return () => {
      resized?.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', update);
      composer.removeEventListener('input', update);
      composer.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, restOnComposer, ...deps]);
  return look;
}

/** Same hat geometry as `NekkoAvatar`, on the peek face's identical 32px grid. */
const WIZARD_HAT_TRANSFORM = 'translate(16.5 9) scale(0.8) translate(-16.5 -12)';

/** The pixel head peeking over a composer edge, paws hanging over it. */
export const PeekNekkoArt = React.forwardRef<SVGSVGElement, { className: string; look: { x: number; y: number }; laugh?: boolean; wizardHat?: boolean }>(function PeekNekkoArt(
  { className, look, laugh = false, wizardHat = false },
  ref,
) {
  return (
    <svg ref={ref} className={className} viewBox="0 0 32 30" width="80" height="75" shapeRendering="crispEdges" aria-hidden="true" focusable="false" overflow={wizardHat ? 'visible' : undefined}>
      {/* Only the paws hang over the composer; the chin stays behind its edge. */}
      <svg data-part="peek-face" width="32" height="25" viewBox="0 0 32 25" overflow="hidden">
        <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2" />
        {laugh ? <g data-nekko-laugh fill="var(--ink)">
          <path d="M10 17V15H11V14H13V15H14V17H13V16H11V17Z M19 17V15H20V14H22V15H23V17H22V16H20V17Z M14 20H19V22H18V23H15V22H14Z" />
        </g> : <g data-nekko-look transform={`translate(${look.x} ${look.y})`} fill="var(--ink)">
          <path d="M11 15H13V18H11Z M20 15H22V18H20Z" />
        </g>}
      </svg>
      {wizardHat && <g data-part="orange-wizard-hat" strokeLinejoin="miter" transform={WIZARD_HAT_TRANSFORM}>
        <polygon points="9,10 16,0 19,2 23,10" fill="#fb923c" stroke="#9a3412" strokeWidth="1" />
        <rect x="8" y="9" width="17" height="3" fill="#ea580c" stroke="#9a3412" strokeWidth="1" />
        <rect x="16" y="7" width="3" height="2" fill="#fde68a" />
      </g>}
      <g data-part="peek-paws" transform="translate(0 50) scale(1 -1)">
        <path d="M6 24H11V28H6Z M21 24H26V28H21Z" fill="var(--surface)" />
        <path d="M5 23H12V27H11V24H6V27H5Z M20 23H27V27H26V24H21V27H20Z" fill="var(--ink)" />
        <path d="M7.5 24H8V25.5H7.5Z M9 24H9.5V25.5H9Z M22.5 24H23V25.5H22.5Z M24 24H24.5V25.5H24Z" fill="var(--ink)" opacity="0.55" />
      </g>
    </svg>
  );
});

/** Local tap-to-laugh greeting; gaze follows this composer's caret at rest. */
export function GreetingNekko() {
  const ref = useRef<SVGSVGElement>(null);
  const [laugh, setLaugh] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const laughNow = () => {
    clearTimeout(timer.current);
    setLaugh(n => n + 1);
    timer.current = setTimeout(() => setLaugh(0), 1200);
  };
  const look = useComposerGaze(ref, { deps: [laugh] });
  return (
    <span className="greeting-nekko-slot"><button type="button" className="greeting-nekko-button" onClick={laughNow} aria-label="Make Nekko laugh" aria-pressed={laugh > 0}>
      <PeekNekkoArt key={laugh} ref={ref} className={`greeting-nekko${laugh ? ' is-laughing' : ''}`} look={look} laugh={laugh > 0} />
    </button></span>
  );
}

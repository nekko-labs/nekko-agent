import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HtmlPreviewServed, PreviewCommand, PreviewState } from '@nekko-agent/shared';
import type { DesignVersion } from '../../artifactsIndex.js';
import { SERVED_PREVIEW_SANDBOX } from '../ArtifactPreview.js';
import { FilePane } from '../FilePane.js';
import { SlideToggle, type SlideOption } from './SlideToggle.js';
import {
  FRAME, ZOOM, dotSpacing, fitView, frameSize, isAnimating, keyAction, readPreviewHand, readPreviewState, readPreviewTargets, readPreviewWheel, wheelZoom, zoomAt,
  type CanvasSize, type CanvasView,
} from './designCanvasView.js';

/** When to ask a loaded design what is moving: once it settles, and again to catch a script-driven loop. */
const PROBES_MS = [400, 1400, 3000];

/** How long after the last move of a gesture the view settles into React state (the zoom figure, the buttons). */
const SETTLE_MS = 120;
const HIGHLIGHT_KEY = 'nekko.library.highlightClickable';
const readHighlight = () => { try { return window.localStorage.getItem(HIGHLIGHT_KEY) === 'on'; } catch { return false; } };

/** Keys that type or press something, where Space is not the hand. */
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName));

/**
 * A design on a canvas: the page at its full size on a dotted surface. The
 * design always takes clicks and hover, so a prototype responds at once. The
 * canvas moves by dragging the space around the design, or anywhere while
 * Space is held, and by scrolling anywhere (over the design too, unless the
 * spot has its own scroll box); a pinch or Ctrl/Cmd+scroll zooms. A design
 * that moves gets Play/Pause; one saved more than once gets its versions.
 *
 * The page runs where every served page does: an opaque-origin sandbox with
 * no network. The canvas only posts it five words (probe, pause, play, targets,
 * untargets) and believes nothing it says beyond a size, whether it is moving,
 * a capped scroll step, whether Space is down and boxes cut to its own frame.
 *
 * Moving is painted straight onto the frame once per animation frame and only
 * settles into React state when the gesture pauses, so a drag or a trackpad
 * fling never re-renders the canvas per pointer event.
 * A host that cannot serve the page shows the ordinary file pane instead.
 */
export function DesignCanvas({ path, title, versions, onVersion, onSource }: {
  path: string;
  title: string;
  versions?: readonly DesignVersion[];
  onVersion: (path: string) => void;
  onSource: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [served, setServed] = useState<HtmlPreviewServed | null>(null);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<CanvasSize>(FRAME);
  // The view lives in a ref so a gesture can paint it without a render; `settled` re-renders when it rests.
  const viewRef = useRef<CanvasView | null>(null);
  const [, setSettled] = useState<CanvasView | null>(null);
  const view = viewRef.current;
  const layer = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(readHighlight);
  const [targets, setTargets] = useState<Array<[number, number, number, number]>>([]);
  const [motion, setMotion] = useState({ animating: false, paused: false });
  const [dragging, setDragging] = useState(false);
  // Space held, in the canvas or in the design: the whole surface drags.
  const [hand, setHand] = useState(false);
  // What the page last said, whether its size was taken, and whether the person has moved the view.
  const page = useRef<{ last: PreviewState | null; sized: boolean; moved: boolean }>({ last: null, sized: false, moved: false });
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    let live = true;
    let id = '';
    const release = (served: string) => { void window.nekko.releaseHtmlPreview?.(served).catch(() => {}); };
    page.current = { last: null, sized: false, moved: false };
    setServed(null); setFailed(false); setSize(FRAME); setView(null); setMotion({ animating: false, paused: false }); setHand(false); setTargets([]);
    const serve = window.nekko.serveHtmlPreview;
    if (!serve) { setFailed(true); return; }
    serve(path, { internet: false, controls: true }).then((s) => {
      if (!s?.url) throw new Error('not served');
      if (!live) { release(s.id); return; }
      id = s.id;
      setServed(s);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (id) release(id); };
  }, [path]);

  // The latest view and frame size, for gestures the page passes up between renders.
  const latest = useRef({ view, size });
  latest.current = { view, size };

  // The page's reports. Only this frame's own window is listened to, and only numbers and flags are read from it.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const boxes = readPreviewTargets(e.data, latest.current.size);
      if (boxes) { setTargets(boxes); return; }
      const down = readPreviewHand(e.data);
      if (down !== null) { setHand(down); return; }
      const wheel = readPreviewWheel(e.data, latest.current.size);
      if (wheel) {
        const v = latest.current.view;
        if (!v) return;
        // The pointer in the page, placed on the canvas.
        const point = { x: v.x + wheel.x * v.z, y: v.y + wheel.y * v.z };
        if (wheel.zoom) move((w) => zoomAt(w, wheelZoom(wheel.dy), point));
        else move((w) => ({ ...w, x: w.x - wheel.dx, y: w.y - wheel.dy }));
        return;
      }
      const state = readPreviewState(e.data);
      if (!state) return;
      const p = page.current;
      // Its size is taken once: a page sized in viewport units would grow with every answer.
      if (!p.sized) { p.sized = true; setSize(frameSize(state)); }
      const animating = isAnimating(p.last, state);
      p.last = state;
      setMotion((m) => ({ animating: m.animating || animating, paused: state.paused }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // An opaque origin has no address to name, so the word goes to whatever is in this frame.
  const send = (command: PreviewCommand) => frame.current?.contentWindow?.postMessage({ nekkoPreview: command }, '*');
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const probe = () => {
    timers.current.forEach(clearTimeout);
    timers.current = PROBES_MS.map((ms) => setTimeout(() => send('probe'), ms));
    if (highlightRef.current) send('targets');
  };
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const toggleHighlight = () => {
    const next = !highlight;
    setHighlight(next);
    try { window.localStorage.setItem(HIGHLIGHT_KEY, next ? 'on' : 'off'); } catch { /* best effort */ }
    send(next ? 'targets' : 'untargets');
    if (!next) setTargets([]);
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const canvasSize = (): CanvasSize => ({ width: wrap.current?.clientWidth ?? 0, height: wrap.current?.clientHeight ?? 0 });
  const fit = () => { page.current.moved = false; setView(fitView(canvasSize(), size)); };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // Fitted until the person moves it: when the design reports its size, and when the window changes.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const refit = () => { if (!page.current.moved && el.clientWidth > 0) setView(fitView({ width: el.clientWidth, height: el.clientHeight }, size)); };
    refit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [size, served]);

  // Paint the view onto the frame, the outlines over it and the dots under it, without React.
  const paint = (v: CanvasView) => {
    const t = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    if (frame.current) frame.current.style.transform = t;
    if (layer.current) { layer.current.style.transform = t; layer.current.style.setProperty('--z', String(v.z)); }
    const el = wrap.current;
    if (el) { const d = dotSpacing(v.z); el.style.backgroundSize = `${d}px ${d}px`; el.style.backgroundPosition = `${v.x}px ${v.y}px`; }
  };
  const painting = useRef(0);
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { cancelAnimationFrame(painting.current); clearTimeout(settling.current); }, []);
  /** Put a view in place now: a fit, or the end of a gesture. */
  function setView(v: CanvasView | null) {
    viewRef.current = v;
    clearTimeout(settling.current);
    setSettled(v);
  }
  const move = (next: (v: CanvasView) => CanvasView) => {
    const v = viewRef.current;
    if (!v) return;
    page.current.moved = true;
    viewRef.current = next(v);
    if (!painting.current) painting.current = requestAnimationFrame(() => { painting.current = 0; if (viewRef.current) paint(viewRef.current); });
    clearTimeout(settling.current);
    settling.current = setTimeout(() => setSettled(viewRef.current), SETTLE_MS);
  };
  const zoomBy = (factor: number) => { const c = canvasSize(); move((v) => zoomAt(v, factor, { x: c.width / 2, y: c.height / 2 })); };

  // Scroll moves the canvas; a pinch or Ctrl/Cmd+scroll zooms at the pointer. React's own
  // wheel listener is passive, and the page behind must not scroll or zoom.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const box = el.getBoundingClientRect();
        const point = { x: e.clientX - box.left, y: e.clientY - box.top };
        move((v) => zoomAt(v, wheelZoom(e.deltaY), point));
      } else {
        move((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [served, failed]);

  // Space held while the app has the keyboard (inside the design, the page says so instead); arrows, + - 0 1 move and zoom.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isField(e.target) || e.defaultPrevented) return;
      if (e.code === 'Space') { e.preventDefault(); setHand(true); return; }
      const v = viewRef.current;
      const action = v && keyAction(e, v, canvasSize());
      if (!action) return;
      e.preventDefault();
      if (action === 'fit') fitRef.current(); else move(() => action);
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setHand(false); };
    const away = () => setHand(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', away);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', away); };
  }, []);

  if (failed) return <FilePane path={path} />;

  const versionOptions: ReadonlyArray<SlideOption<string>> = (versions ?? []).map((v) => ({ id: v.path, label: `Version ${v.version}`, content: `v${v.version}` }));
  const percent = Math.round((view?.z ?? 1) * 100);
  const placed = view ? `translate(${view.x}px, ${view.y}px) scale(${view.z})` : undefined;
  const dots = view ? dotSpacing(view.z) : 18;
  return (
    <div className="flex h-full min-h-0 flex-col" data-design-view>
      <div className="flex flex-wrap items-center gap-4 px-5 py-2 text-xs" data-design-controls>
        {versionOptions.length > 1 && <SlideToggle label="Version" options={versionOptions} value={path} onChange={onVersion} />}
        <span className="hidden text-2xs text-ink-faint lg:inline" data-design-hint>Hold Space to drag over the design</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="ctl-toggle text-2xs" data-design-highlight aria-pressed={highlight} onClick={toggleHighlight}
            title={highlight ? 'Stop outlining what can be clicked' : 'Outline the links, buttons and fields in the design'}>
            <span className="ctl-dot" /> Highlight clickable
          </button>
          {motion.animating && (
            <button type="button" className="btn btn-ghost" data-design-playback onClick={() => send(motion.paused ? 'play' : 'pause')}
              title={motion.paused ? 'Resume the design’s motion' : 'Hold the design’s motion where it is'}>
              {motion.paused ? 'Play' : 'Pause'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" aria-label="Zoom out" title="Zoom out" disabled={(view?.z ?? 1) <= ZOOM.min} onClick={() => zoomBy(1 / ZOOM.step)}>−</button>
          <button type="button" className="btn btn-ghost tabular-nums" data-design-zoom aria-label={`Zoom ${percent}%. Fit to the window`} title="Fit to the window" onClick={fit}>{percent}%</button>
          <button type="button" className="btn btn-ghost" aria-label="Zoom in" title="Zoom in" disabled={(view?.z ?? 1) >= ZOOM.max} onClick={() => zoomBy(ZOOM.step)}>+</button>
          <button type="button" className="btn btn-ghost" data-design-source onClick={onSource} title="Open the file itself: source, viewport sizes and Add to design board">Source</button>
        </div>
      </div>
      <div
        ref={wrap}
        data-design-canvas
        className="diagram-canvas relative min-h-0 flex-1 overflow-hidden"
        style={{
          cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none',
          backgroundSize: `${dots}px ${dots}px`, backgroundPosition: view ? `${view.x}px ${view.y}px` : undefined,
        }}
        data-design-hand={hand || undefined}
        onPointerDown={(e) => {
          // Reaches here from the space around the design, or from anywhere while Space is held.
          const v = viewRef.current;
          if (!v || e.button !== 0) return;
          drag.current = { dx: e.clientX - v.x, dy: e.clientY - v.y };
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => { const d = drag.current; if (d) move((v) => ({ ...v, x: e.clientX - d.dx, y: e.clientY - d.dy })); }}
        onPointerUp={() => { drag.current = null; setDragging(false); }}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
        // Double-click the space around the design to zoom in there; with Shift, out.
        onDoubleClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const point = { x: e.clientX - box.left, y: e.clientY - box.top };
          move((v) => zoomAt(v, e.shiftKey ? 1 / (ZOOM.step * ZOOM.step) : ZOOM.step * ZOOM.step, point));
        }}
      >
        {served
          ? <iframe ref={frame} key={served.url} title={title} src={served.url} sandbox={SERVED_PREVIEW_SANDBOX} referrerPolicy="no-referrer" onLoad={probe}
              className="design-canvas-frame"
              style={{
                width: size.width, height: size.height, pointerEvents: hand || dragging ? 'none' : 'auto', visibility: view ? 'visible' : 'hidden',
                transform: placed,
              }} />
          : <p className="p-5 text-xs text-ink-faint">Loading…</p>}
        {served && highlight && (
          // Drawn by the canvas over the design, never inside it; the pointer passes through.
          <div ref={layer} className="design-canvas-targets" data-design-targets aria-hidden="true"
            style={{ width: size.width, height: size.height, transform: placed, '--z': view?.z ?? 1 } as React.CSSProperties}>
            {targets.map(([x, y, w, h], i) => <span key={i} style={{ left: x, top: y, width: w, height: h }} />)}
          </div>
        )}
      </div>
    </div>
  );
}

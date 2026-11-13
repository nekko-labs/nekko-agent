import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HtmlPreviewServed, PreviewCommand, PreviewState } from '@nekko-agent/shared';
import type { DesignVersion } from '../../artifactsIndex.js';
import { SERVED_PREVIEW_SANDBOX } from '../ArtifactPreview.js';
import { FilePane } from '../FilePane.js';
import { SlideToggle, type SlideOption } from './SlideToggle.js';
import { FRAME, ZOOM, fitView, frameSize, isAnimating, readPreviewState, zoomAt, type CanvasSize, type CanvasView } from './designCanvasView.js';

/** When to ask a loaded design what is moving: once it settles, and again to catch a script-driven loop. */
const PROBES_MS = [400, 1400, 3000];

/**
 * A design on a canvas: the page at its full size on a dotted surface, moved
 * by dragging or scrolling and zoomed with a pinch or Ctrl/Cmd+scroll. A
 * design that moves gets Play/Pause; one saved more than once gets its
 * versions; Interact hands the pointer to the page for a clickable prototype.
 *
 * The page runs where every served page does: an opaque-origin sandbox with
 * no network. The canvas only posts it three words (probe, pause, play) and
 * believes nothing it answers beyond a size and whether it is moving.
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
  const [view, setView] = useState<CanvasView | null>(null);
  const [motion, setMotion] = useState({ animating: false, paused: false });
  const [interact, setInteract] = useState(false);
  const [dragging, setDragging] = useState(false);
  // What the page last said, whether its size was taken, and whether the person has moved the view.
  const page = useRef<{ last: PreviewState | null; sized: boolean; moved: boolean }>({ last: null, sized: false, moved: false });
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    let live = true;
    let id = '';
    const release = (served: string) => { void window.nekko.releaseHtmlPreview?.(served).catch(() => {}); };
    page.current = { last: null, sized: false, moved: false };
    setServed(null); setFailed(false); setSize(FRAME); setView(null); setMotion({ animating: false, paused: false }); setInteract(false);
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

  // The page's reports. Only this frame's own window is listened to, and only numbers are read from it.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
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
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const canvasSize = (): CanvasSize => ({ width: wrap.current?.clientWidth ?? 0, height: wrap.current?.clientHeight ?? 0 });
  const fit = () => { page.current.moved = false; setView(fitView(canvasSize(), size)); };
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

  const move = (next: (v: CanvasView) => CanvasView) => { page.current.moved = true; setView((v) => (v ? next(v) : v)); };
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
        move((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), point));
      } else {
        move((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [served, failed]);

  if (failed) return <FilePane path={path} />;

  const versionOptions: ReadonlyArray<SlideOption<string>> = (versions ?? []).map((v) => ({ id: v.path, label: `Version ${v.version}`, content: `v${v.version}` }));
  const percent = Math.round((view?.z ?? 1) * 100);
  return (
    <div className="flex h-full min-h-0 flex-col" data-design-view>
      <div className="flex flex-wrap items-center gap-4 px-5 py-2 text-xs" data-design-controls>
        {versionOptions.length > 1 && <SlideToggle label="Version" options={versionOptions} value={path} onChange={onVersion} />}
        <div className="ml-auto flex items-center gap-2">
          {motion.animating && (
            <button type="button" className="btn btn-ghost" data-design-playback onClick={() => send(motion.paused ? 'play' : 'pause')}
              title={motion.paused ? 'Resume the design’s motion' : 'Hold the design’s motion where it is'}>
              {motion.paused ? 'Play' : 'Pause'}
            </button>
          )}
          <button type="button" className="ctl-toggle" aria-pressed={interact} data-design-interact onClick={() => setInteract((on) => !on)}
            title={interact ? 'The design has the pointer. Click to move the canvas again.' : 'Let clicks and hover reach the design, for a prototype that responds.'}>
            <span className="ctl-dot" /> Interact
          </button>
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
        style={{ cursor: interact ? 'default' : dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (interact || !view || e.button !== 0) return;
          drag.current = { dx: e.clientX - view.x, dy: e.clientY - view.y };
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => { const d = drag.current; if (d) move((v) => ({ ...v, x: e.clientX - d.dx, y: e.clientY - d.dy })); }}
        onPointerUp={() => { drag.current = null; setDragging(false); }}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
      >
        {served
          ? <iframe ref={frame} key={served.url} title={title} src={served.url} sandbox={SERVED_PREVIEW_SANDBOX} referrerPolicy="no-referrer" onLoad={probe}
              className="design-canvas-frame"
              style={{
                width: size.width, height: size.height, pointerEvents: interact ? 'auto' : 'none', visibility: view ? 'visible' : 'hidden',
                transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.z})` : undefined,
              }} />
          : <p className="p-5 text-xs text-ink-faint">Loading…</p>}
      </div>
    </div>
  );
}

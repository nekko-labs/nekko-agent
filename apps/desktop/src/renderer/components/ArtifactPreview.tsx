import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isServableHtml, type HtmlPreviewServed, type PreviewTextEdit } from '@nekko-agent/shared';
import { readPreviewTextEdit } from './htmlTextEdit.js';

/** Untrusted documents get an opaque origin, no app bridge, and no network. */
export function isolatedDocument(source: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer">${source}`;
}

/**
 * The sandbox a served page gets: scripts, forms (the server's policy stops
 * them submitting anywhere) and alerts, but no `allow-same-origin`, so the
 * page's origin is opaque and it can reach no cookie, storage or API of the
 * app, even on the same host. No popups and no top navigation either.
 */
export const SERVED_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals';

function ViewportSelect({ width, onChange }: { width: string; onChange: (width: string) => void }) {
  return <select aria-label="Preview viewport" className="input w-auto" value={width} onChange={(e) => onChange(e.target.value)}>
    <option value="100%">Fit</option><option value="375px">Phone · 375</option><option value="768px">Tablet · 768</option><option value="1280px">Desktop · 1280</option>
  </select>;
}

/**
 * An HTML preview. Given the page's `path` and a host that can serve it, the
 * page runs live with its own folder (`ServedPreview`); otherwise its text is
 * drawn in a scriptless, network-less frame (`StaticPreview`).
 */
export function ArtifactPreview({ source, title = 'Design preview', path, onTextEdit, reloadKey }: {
  source: string;
  title?: string;
  path?: string;
  /** Offer Edit text: a piece of text clicked and changed in the running page comes here. */
  onTextEdit?: (edit: PreviewTextEdit) => void;
  /** Reload the served page when this changes (a save that reached the disk), instead of whenever `source` does. */
  reloadKey?: string | number;
}) {
  const servable = !!path && isServableHtml(path) && typeof window !== 'undefined' && !!window.nekko?.serveHtmlPreview;
  return servable ? <ServedPreview path={path} source={source} title={title} onTextEdit={onTextEdit} reloadKey={reloadKey} /> : <StaticPreview source={source} title={title} />;
}

/**
 * A local .html page live, served with its folder by the host so its own
 * stylesheets, scripts, images and fonts load. The network stays off until
 * "Load from internet" is switched on for this preview (https and wss only);
 * opening another file turns it off again. If the host refuses or can't
 * serve the page, the scriptless preview shows with the reason.
 */
function ServedPreview({ path, source, title, onTextEdit, reloadKey }: {
  path: string; source: string; title: string; onTextEdit?: (edit: PreviewTextEdit) => void; reloadKey?: string | number;
}) {
  const [width, setWidth] = useState('100%');
  const [internet, setInternet] = useState(false);
  // Edit text: the page is served again with the editor script, and its changes come back here.
  const [editing, setEditing] = useState(false);
  const [served, setServed] = useState<HtmlPreviewServed | null>(null);
  const [failed, setFailed] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const report = useRef(onTextEdit);
  report.current = onTextEdit;
  const canEdit = !!onTextEdit;
  useEffect(() => { setInternet(false); setEditing(false); }, [path]);
  useEffect(() => {
    if (!editing) return;
    // Only this frame's own page is heard, and only a well-formed text change is taken from it.
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const edit = readPreviewTextEdit(e.data);
      if (edit) report.current?.(edit);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [editing]);
  useEffect(() => {
    let live = true;
    let id = '';
    const release = (served: string) => { void window.nekko.releaseHtmlPreview?.(served).catch(() => {}); };
    setServed(null); setFailed('');
    window.nekko.serveHtmlPreview!(path, { internet, edit: editing && canEdit }).then((s) => {
      if (!s?.url) throw new Error('Nothing here can serve the page.');
      if (!live) { release(s.id); return; }
      id = s.id;
      setServed(s);
    }).catch((e) => { if (live) setFailed((e as Error).message || 'The page could not be served.'); });
    return () => { live = false; if (id) release(id); };
  }, [path, internet, editing, canEdit]);
  if (failed) return <StaticPreview source={source} title={title} note={`${failed} Showing it without its files or scripts.`} />;
  return <div className="flex h-full min-h-96 flex-col gap-2 p-3" data-served-preview>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <strong>{title}</strong>
      <ViewportSelect width={width} onChange={setWidth} />
      <button type="button" className="ctl-toggle text-2xs" aria-pressed={internet} onClick={() => setInternet((on) => !on)} data-preview-internet
        title={internet ? 'This page may load from the internet (https only). Click to block it again.' : 'Only files in this page’s folder load. Click to let it load from the internet too.'}>
        <span className="ctl-dot" /> Load from internet
      </button>
      {canEdit && (
        <button type="button" className="ctl-toggle text-2xs" aria-pressed={editing} onClick={() => setEditing((on) => !on)} data-preview-edit
          title={editing ? 'Stop editing text in the page' : 'Click any piece of text in the page to change it; Enter saves it to the file, Escape cancels'}>
          <span className="ctl-dot" /> Edit text
        </button>
      )}
      {editing && <span className="text-2xs text-ink-faint" data-preview-edit-hint>Click text to change it · Enter saves · Esc cancels</span>}
    </div>
    <div className="min-h-96 flex-1 overflow-auto rounded-lg bg-surface-2">
      {served
        // A saved edit reloads the frame from disk: `reloadKey` says when the save landed, else a change of `source` does.
        ? <iframe ref={frame} key={`${served.url}:${reloadKey ?? `${source.length}:${hashText(source)}`}`} title={title} src={served.url} sandbox={SERVED_PREVIEW_SANDBOX}
            referrerPolicy="no-referrer" style={{ width, height: '100%', minHeight: 480, border: 0, background: 'white' }} />
        : <p className="p-4 text-xs text-ink-faint">Loading…</p>}
    </div>
  </div>;
}

/** A cheap, stable fingerprint of the page text, to reload the frame when it changes. */
function hashText(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
}

/** The page's text in a scriptless frame with no network and no app bridge. */
function StaticPreview({ source, title, note }: { source: string; title: string; note?: string }) {
  const [width, setWidth] = useState('100%');
  const [error, setError] = useState('');
  const openInteractive = async () => {
    const bridge = (window as unknown as { nekkoPreview?: { open: (source: string) => Promise<void> } }).nekkoPreview;
    if (!bridge) { setError('Interactive isolated previews require the desktop app. Static preview remains available.'); return; }
    try { await bridge.open(source); setError(''); } catch (e) { setError((e as Error).message); }
  };
  return <div className="flex h-full min-h-96 flex-col gap-2 p-3">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <strong>{title}</strong>
      <ViewportSelect width={width} onChange={setWidth} />
      <button className="chip chip-action" onClick={openInteractive}>Open interactive preview</button>
      <span className="text-ink-faint">Isolated · network blocked</span>
    </div>
    {(note || error) && <p role="status" className="text-xs text-ink-soft">{error || note}</p>}
    <div className="min-h-96 flex-1 overflow-auto rounded-lg border border-line bg-surface-2">
      <iframe title={title} sandbox="" referrerPolicy="no-referrer"
        srcDoc={isolatedDocument(source)} style={{ width, height: '100%', minHeight: 480, border: 0, background: 'white' }} />
    </div>
  </div>;
}

let mermaidQueue: Promise<unknown> = Promise.resolve();

/**
 * The rendered SVG wrapped in a page that fits it to its frame. Scriptless:
 * a `srcdoc` frame inherits the renderer's CSP, which allows no inline script,
 * so zoom and pan in the full window are done from outside by transforming
 * the frame element itself (see `ZoomFrame`). Every diagram frame therefore
 * stays `sandbox=""` with no network and no bridge.
 */
export function diagramDocument(svg: string, background = '#16161c', dots = '#8a8a97'): string {
  // A matching opaque canvas also avoids Chromium's white iframe backing store.
  const safe = (value: string, fallback: string) => /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
  const style = `<style>html,body{margin:0;height:100%;background:${safe(background, '#16161c')};overflow:hidden}body{background-image:radial-gradient(circle,color-mix(in srgb,${safe(dots, '#8a8a97')} 25%,transparent) .75px,transparent .85px);background-size:18px 18px}#w{height:100%;display:flex;align-items:center;justify-content:center}#w svg{max-width:100%;max-height:100%;height:auto;width:auto;background:transparent!important}</style>`;
  return isolatedDocument(`${style}<div id="w">${svg}</div>`);
}

/** Zoom limits for the full-window diagram. */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 8;

/**
 * A sandboxed frame the user can zoom with the wheel and drag to pan. The
 * frame ignores pointer events so the wrapper gets them all; the frame is
 * moved and scaled as one element, which keeps the untrusted document inert.
 */
export function ZoomFrame({ srcDoc, title }: { srcDoc: string; title: string }) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const drag = React.useRef<{ dx: number; dy: number } | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // React registers wheel as passive at the root, so preventDefault (keeping
    // the chat behind from scrolling) needs a listener of our own.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => ({ ...v, z: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  return (
    <div
      ref={wrap}
      data-zoom-frame
      className="relative min-h-0 flex-1 overflow-hidden diagram-canvas"
      style={{ cursor: drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
      onPointerDown={(e) => { drag.current = { dx: e.clientX - view.x, dy: e.clientY - view.y }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { const d = drag.current; if (d) setView((v) => ({ ...v, x: e.clientX - d.dx, y: e.clientY - d.dy })); }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => setView({ z: 1, x: 0, y: 0 })}
    >
      <iframe
        title={title}
        sandbox=""
        srcDoc={srcDoc}
        className="absolute inset-0 h-full w-full border-0 bg-transparent"
        style={{ pointerEvents: 'none', transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: 'center center' }}
      />
      <span className="pointer-events-none absolute bottom-2 right-3 rounded-md bg-black/50 px-2 py-0.5 font-mono text-2xs text-white" aria-live="polite">{Math.round(view.z * 100)}%</span>
    </div>
  );
}

/** Only app theme colors, never diagram source, enter Mermaid's theme CSS. */
function diagramTheme() {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  const css = root ? getComputedStyle(root) : null;
  const color = (token: string, fallback: string) => {
    const value = css?.getPropertyValue(token).trim() ?? '';
    return /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
  };
  return { background: color('--surface', '#16161c'), foreground: color('--ink', '#eceaf3'),
    secondary: color('--surface-2', '#202027'), line: color('--ink-faint', '#8a8a97'),
    dark: root?.dataset.theme !== 'light' };
}

/**
 * A fenced ```mermaid block drawn inline. Hover shows an Expand button that
 * opens the same drawing in a full-window overlay with zoom and pan, so a
 * sequence diagram with twenty lifelines is readable without leaving the chat.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState(diagramTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(diagramTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-preset', 'style', 'class'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    setSvg(''); setError('');
    if (code.length > 30_000) { setError('Diagram exceeds the 30 KB preview limit.'); return; }
    mermaidQueue = mermaidQueue.catch(() => {}).then(async () => {
      if (!live) return;
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 30_000, suppressErrorRendering: true,
          theme: 'base', themeVariables: { darkMode: theme.dark, background: theme.background,
            primaryColor: theme.secondary, primaryTextColor: theme.foreground, primaryBorderColor: theme.line,
            secondaryColor: theme.background, tertiaryColor: theme.secondary,
            lineColor: theme.line, textColor: theme.foreground, mainBkg: theme.secondary,
            nodeBorder: theme.line, clusterBkg: theme.background, clusterBorder: theme.line,
            edgeLabelBackground: theme.background, titleColor: theme.foreground,
            actorBkg: theme.secondary, actorBorder: theme.line, actorTextColor: theme.foreground,
            signalColor: theme.foreground, signalTextColor: theme.foreground,
            noteBkgColor: theme.secondary, noteTextColor: theme.foreground, noteBorderColor: theme.line,
          } });
        const result = await mermaid.render(`diagram${id}`, code);
        if (live) setSvg(result.svg);
      } catch { if (live) setError('Diagram could not be rendered. Check the Mermaid source below.'); }
    });
    return () => { live = false; };
  }, [code, id, theme]);
  useEffect(() => {
    if (!full) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setFull(false); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [full]);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  };
  const toolbarButton = 'rounded-md border border-line px-2 py-0.5 text-2xs text-ink-faint hover:text-ink';
  return <div className="group/diagram relative my-2 rounded-xl p-3 diagram-canvas diagram-card" data-mermaid-diagram>
    {error ? <p role="status" className="text-xs text-ink-soft">{error}</p> : svg
      ? <>
          <iframe title="Mermaid diagram" sandbox="" srcDoc={diagramDocument(svg, theme.background, theme.line)} className="h-80 w-full border-0 bg-transparent" />
          <div className="absolute right-4 top-4 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/diagram:opacity-100">
            <button type="button" className={toolbarButton} style={{ background: 'var(--surface)' }} onClick={copy} title="Copy Mermaid source">{copied ? '✓ copied' : 'Copy'}</button>
            <button type="button" className={toolbarButton} style={{ background: 'var(--surface)' }} onClick={() => setFull(true)} title="Open the diagram in a full window" data-mermaid-expand>Expand</button>
          </div>
        </>
      : <p className="text-xs text-ink-faint">Rendering diagram…</p>}
    <details><summary className="cursor-pointer text-xs">Mermaid source</summary><pre className="overflow-auto text-xs">{code}</pre></details>
    {full && svg && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 z-[120] flex flex-col bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Diagram, full window" data-mermaid-fullscreen onClick={() => setFull(false)}>
        <div className="card flex min-h-0 flex-1 flex-col overflow-hidden p-0 shadow-(--shadow-float)" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
            <strong className="flex-1">Diagram</strong>
            <span className="text-ink-faint">Scroll to zoom · drag to pan · double-click to reset</span>
            <button type="button" className={toolbarButton} onClick={copy}>{copied ? '✓ copied' : 'Copy source'}</button>
            <button type="button" className={toolbarButton} onClick={() => setFull(false)} aria-label="Close full window" title="Close (Esc)">Close</button>
          </div>
          <ZoomFrame title="Mermaid diagram, full window" srcDoc={diagramDocument(svg, theme.background, theme.line)} />
        </div>
      </div>,
      document.body,
    )}
  </div>;
}

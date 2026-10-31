import React from 'react';
import type { FileContent } from '@nekko-agent/shared';
import { LOCAL_IMAGE_EXT } from '../localImages.js';
import { LocalImageCard } from './LocalImageCard.js';
import type { ChatArtifact } from '../chatArtifacts.js';
import { useStore } from '../store.js';
import { MarkdownSandbox, safeHref } from './Markdown.js';
import { isolatedDocument } from './ArtifactPreview.js';

const HTML_EXT = /\.html?$/i;
/** The page is laid out at a desktop size, then scaled down to the card. */
export const THUMB_VIEWPORT = { width: 1280, height: 800 };
/** Above this the card stays plain: a thumbnail is not worth parsing a page this big. */
export const THUMB_MAX_CHARS = 1_000_000;

type PreviewBridge = { open: (source: string) => Promise<void> };
const previewBridge = () => (typeof window === 'undefined' ? undefined : (window as unknown as { nekkoPreview?: PreviewBridge }).nekkoPreview);

/** What a read of the page gives the card: its source to draw, or why not. */
export function htmlThumbnail(file: FileContent): { source: string } | { note: string } {
  if (file.binary) return { note: 'Preview unavailable' };
  if (file.truncated || file.content.length > THUMB_MAX_CHARS) return { note: 'Too large to preview here' };
  if (!file.content.trim()) return { note: 'Empty page' };
  return { source: file.content };
}

export function ChatArtifacts({ artifacts, sessionId }: { artifacts: ChatArtifact[]; sessionId: string }) {
  const sandbox = React.useContext(MarkdownSandbox);
  if (!artifacts.length) return null;
  return <div className="my-2 grid gap-2" aria-label="Response artifacts">
    {artifacts.map(artifact => artifact.live
      ? <LivePreviewCard key={artifact.path} artifact={artifact} />
      : LOCAL_IMAGE_EXT.test(artifact.path)
      ? <LocalImageCard key={artifact.path} src={artifact.path} title={artifact.title} sessionId={sessionId} />
      : HTML_EXT.test(artifact.path)
      ? <HtmlRenderingCard key={artifact.path} artifact={artifact} sessionId={sessionId} />
      : <button key={artifact.path} type="button" disabled={sandbox}
      className="artifact-card group flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left disabled:opacity-50"
      title={sandbox ? 'Host file previews are unavailable in Sandbox' : `Open ${artifact.path}`}
      onClick={() => useStore.getState().openFilePane(artifact.path, sessionId)}>
      <span className="artifact-card-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-2xs font-semibold uppercase" aria-hidden>{artifact.filename.split('.').at(-1)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.title}</span><span className="block truncate text-2xs text-ink-soft">{artifact.filename}</span></span>
      <span className="artifact-card-open shrink-0 text-xs" aria-hidden>↗</span>
    </button>)}
  </div>;
}

/**
 * A page a reply links to, drawn small. The page is read once the card nears
 * the viewport, the same host read the file pane uses, and drawn in a
 * `sandbox=""` frame: no script, no network (isolatedDocument's CSP), no
 * input. In Sandbox nothing on the host is read and the card stays plain.
 */
export function HtmlRenderingCard({ artifact, sessionId }: { artifact: ChatArtifact; sessionId: string }) {
  const sandbox = React.useContext(MarkdownSandbox);
  const [near, setNear] = React.useState(false);
  const [thumb, setThumb] = React.useState<{ path: string; source?: string; note?: string } | null>(null);
  const [error, setError] = React.useState('');
  const box = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<HTMLIFrameElement>(null);
  const path = artifact.path;

  React.useEffect(() => {
    if (sandbox || near) return;
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [sandbox, near]);

  React.useEffect(() => {
    if (sandbox || !near) return;
    let active = true;
    void window.nekko.readFile(path).then(file => {
      if (active) setThumb({ path, ...htmlThumbnail(file) });
    }).catch(() => { if (active) setThumb({ path, note: 'Could not read the page' }); });
    return () => { active = false; };
  }, [path, sandbox, near]);

  const current = !sandbox && thumb?.path === path ? thumb : null;
  const source = current?.source;

  // Scale the desktop-sized page to the card's width, whatever the card's width.
  React.useEffect(() => {
    const el = box.current;
    if (!source || !el) return;
    const fit = () => { if (frame.current) frame.current.style.transform = `scale(${el.clientWidth / THUMB_VIEWPORT.width})`; };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [source]);

  const open = () => { if (!sandbox) useStore.getState().openFilePane(path, sessionId); };
  const bridge = previewBridge();
  const interactive = async () => {
    if (!bridge || !source) return;
    try { await bridge.open(source); setError(''); } catch (e) { setError((e as Error).message || 'Could not open the interactive preview'); }
  };
  const note = sandbox ? 'Host file previews are unavailable in Sandbox' : current?.note ?? (near ? 'Loading preview…' : '');

  return <div className="artifact-card artifact-render-card flex w-full min-w-0 flex-col overflow-hidden rounded-xl border" role="group" aria-label={`${artifact.title}, HTML page`} data-render-card>
    {/* The thumbnail repeats Open for the pointer; keyboard users have the button below. */}
    <div ref={box} className="artifact-render-thumb relative h-[200px] w-full overflow-hidden" data-render-thumb aria-hidden
      onClick={sandbox ? undefined : open} style={{ cursor: sandbox ? 'default' : 'pointer' }}>
      {source
        ? <iframe ref={frame} title={`${artifact.title} thumbnail`} sandbox="" referrerPolicy="no-referrer" tabIndex={-1} loading="lazy"
          srcDoc={isolatedDocument(source)}
          className="absolute left-0 top-0 border-0 bg-white"
          style={{ width: THUMB_VIEWPORT.width, height: THUMB_VIEWPORT.height, transformOrigin: '0 0', pointerEvents: 'none' }} />
        : <span className="flex h-full items-center justify-center px-4 text-center text-xs text-ink-soft">{note}</span>}
    </div>
    <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
      <span className="artifact-card-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-2xs font-semibold uppercase" aria-hidden>{artifact.filename.split('.').at(-1)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.title}</span><span className="block truncate text-2xs text-ink-soft">{artifact.filename}</span></span>
      <span className="flex shrink-0 items-center gap-1.5">
        {bridge && <button type="button" className="artifact-card-action rounded-md border px-2 py-1 text-xs disabled:opacity-50" disabled={sandbox || !source}
          title={source ? 'Open an interactive preview in its own isolated window' : 'Available once the page has loaded'} onClick={() => { void interactive(); }}>Interactive</button>}
        <button type="button" className="artifact-card-action rounded-md border px-2 py-1 text-xs disabled:opacity-50" disabled={sandbox}
          title={sandbox ? 'Host file previews are unavailable in Sandbox' : `Open ${path}`} onClick={open}>Open ↗</button>
      </span>
    </div>
    {error && <p role="status" className="px-3 pb-2 text-2xs text-ink-soft">{error}</p>}
  </div>;
}

/**
 * A preview server on this machine (`http://localhost:5173/pricing`). Opens in
 * the user's browser like any web link; the app never fetches it, so there is
 * no thumbnail.
 */
export function LivePreviewCard({ artifact }: { artifact: ChatArtifact }) {
  const live = artifact.live!;
  const href = safeHref(live.url);
  if (!href) return null;
  return <a href={href} target="_blank" rel="noreferrer"
    className="artifact-card group flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left no-underline"
    title={`Open ${live.url} in your browser`} data-live-preview>
    <span className="artifact-card-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" aria-hidden>
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8M12 18v3" /><circle cx="12" cy="11" r="2.5" fill="currentColor" stroke="none" /></svg>
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium text-ink">{artifact.title}</span>
      <span className="block truncate text-2xs text-ink-soft"><span className="artifact-live-label font-semibold">Live preview</span> · <span className="font-mono">{live.host}</span>{live.route}</span>
    </span>
    <span className="artifact-card-open shrink-0 text-xs">Open in browser ↗</span>
  </a>;
}

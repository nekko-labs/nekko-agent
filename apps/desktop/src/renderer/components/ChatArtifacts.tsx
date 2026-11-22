import React from 'react';
import { isServableHtml, type FileContent } from '@nekko-agent/shared';
import { LOCAL_IMAGE_EXT } from '../localImages.js';
import { LocalImageCard } from './LocalImageCard.js';
import type { ChatArtifact } from '../chatArtifacts.js';
import { mainCheckoutPath } from '../artifactPaths.js';
import { fileListed, locateMovedFile, type ListDir } from '../locateFile.js';
import { GfArrowUpRightIcon } from '../gentleface-icons.js';
import { artifactKind } from '../artifactsIndex.js';
import { useStore } from '../store.js';
import { MarkdownSandbox, safeHref } from './Markdown.js';
import { isolatedDocument, SERVED_PREVIEW_SANDBOX } from './ArtifactPreview.js';

const HTML_EXT = /\.html?$/i;
/** The page is laid out at a desktop size, then scaled down to the card. */
export const THUMB_VIEWPORT = { width: 1280, height: 800 };
/** Above this the card stays plain: a thumbnail is not worth parsing a page this big. */
export const THUMB_MAX_CHARS = 1_000_000;

/** What a read of the page gives the card: its source to draw, or why not. */
export function htmlThumbnail(file: FileContent): { source: string } | { note: string } {
  if (file.binary) return { note: 'Preview unavailable' };
  if (file.truncated || file.content.length > THUMB_MAX_CHARS) return { note: 'Too large to preview here' };
  if (!file.content.trim()) return { note: 'Empty page' };
  return { source: file.content };
}

/** Where a worktree file lives once its worktree is gone: old path (lower-cased) to the main checkout's. Per app run. */
const moves = new Map<string, Promise<string | null>>();

/** The main-checkout path for a file that is gone from its removed git worktree, else null. Listings only. */
export function followMovedFile(path: string, listDir: (path: string) => Promise<Array<{ name: string }>>): Promise<string | null> {
  const to = mainCheckoutPath(path);
  if (!to) return Promise.resolve(null);
  const key = path.toLowerCase();
  let found = moves.get(key);
  if (!found) {
    const has = async (p: string) => {
      const slash = p.lastIndexOf('/');
      try {
        const listed = await listDir(p.slice(0, slash));
        return Array.isArray(listed) ? listed.some((e) => String(e?.name ?? '').toLowerCase() === p.slice(slash + 1).toLowerCase()) : null;
      } catch { return false; }
    };
    found = (async () => ((await has(path.replaceAll('\\', '/'))) === false && (await has(to)) ? to : null))();
    moves.set(key, found);
    // Only a move is remembered: a worktree still there may be removed later in the run.
    void found.then((to) => { if (!to) moves.delete(key); });
  }
  return found;
}

/** Card files checked so far: a found move is kept for the run, "it's there" or "nowhere" for a minute. */
const located = new Map<string, { at: number; to: Promise<string | null> }>();
const RECHECK_MS = 60_000;

/**
 * Where a card's file is when it is not where the reply's link says (#3212): followed out of a removed
 * worktree, or found by name in a designs folder nearby (a design named by its bare name resolves to the
 * chat folder). Null when the file is there, or nowhere. Listings only.
 */
export function locateCardFile(path: string, listDir: ListDir, now = Date.now()): Promise<string | null> {
  const key = path.toLowerCase();
  const hit = located.get(key);
  if (hit && now - hit.at < RECHECK_MS) return hit.to;
  const to = (async () => ((await fileListed(path, listDir)) === false ? locateMovedFile(path, listDir) : null))();
  located.set(key, { at: now, to });
  void to.then((found) => { if (found) located.set(key, { at: Infinity, to }); });
  return to;
}

/** Moves found so far (old path, lower-cased, to new), and the cards waiting to hear of one. */
const followed = new Map<string, string>();
const listeners = new Set<() => void>();
let followedVersion = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const version = () => followedVersion;

/**
 * The cards' files, each followed to where it is now when it isn't where the reply said: out of a
 * removed worktree, or into the designs folder a bare design name meant (#3212).
 */
function useFollowMoved(artifacts: ChatArtifact[], sandbox: boolean): ChatArtifact[] {
  React.useSyncExternalStore(subscribe, version, version);
  const key = artifacts.filter((a) => !a.live).map((a) => a.path).join('\n');
  React.useEffect(() => {
    const listDir = typeof window === 'undefined' ? undefined : window.nekko?.listDir;
    if (!key || sandbox || !listDir) return;
    for (const path of key.split('\n')) {
      void locateCardFile(path, (dir) => listDir(dir)).then((to) => {
        if (!to || followed.get(path.toLowerCase()) === to) return;
        followed.set(path.toLowerCase(), to);
        followedVersion++;
        for (const listener of listeners) listener();
      });
    }
  }, [key, sandbox]);
  if (!key || sandbox) return artifacts;
  return artifacts.map((a) => { const to = followed.get(a.path.toLowerCase()); return to ? { ...a, path: to } : a; });
}

export function ChatArtifacts({ artifacts: named, sessionId }: { artifacts: ChatArtifact[]; sessionId: string }) {
  const sandbox = React.useContext(MarkdownSandbox);
  const artifacts = useFollowMoved(named, sandbox);
  if (!artifacts.length) return null;
  return <div className="my-2 grid gap-2" aria-label="Response artifacts">
    {artifacts.map(artifact => artifact.live
      ? <LivePreviewCard key={artifact.path} artifact={artifact} />
      : LOCAL_IMAGE_EXT.test(artifact.path)
      ? <LocalImageCard key={artifact.path} src={artifact.path} title={artifact.title} sessionId={sessionId} />
      : HTML_EXT.test(artifact.path)
      ? <HtmlRenderingCard key={artifact.path} artifact={artifact} sessionId={sessionId} />
      : <button key={artifact.path} type="button" disabled={sandbox}
      className="artifact-card group flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2 text-left disabled:opacity-50"
      title={sandbox ? 'Host file previews are unavailable in Sandbox' : `Open ${artifact.path}`}
      onClick={() => useStore.getState().openFilePane(artifact.path, sessionId)}>
      <span className="artifact-card-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-2xs font-semibold uppercase" aria-hidden>{artifact.filename.split('.').at(-1)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.title}</span><span className="block truncate text-2xs text-ink-soft">{artifact.filename}</span></span>
      <span className="artifact-card-open shrink-0 text-xs" aria-hidden>↗</span>
    </button>)}
  </div>;
}

/**
 * A page a reply links to, shown small and always interactive. Once the card
 * nears the viewport the page is served with its folder, the same way the file
 * pane and Library run a page: an opaque-origin sandbox with scripts, no app
 * bridge and no network. It is laid out at a desktop size, scaled to the card,
 * and takes clicks, typing and scrolling like the page itself. Where it cannot
 * be served (no preview server, or the host refuses), the page's text is read
 * and drawn still in a `sandbox=""` frame with no script, network or input,
 * and the picture opens the file pane. In Sandbox nothing on the host is read
 * and the card stays plain.
 */
export function HtmlRenderingCard({ artifact, sessionId }: { artifact: ChatArtifact; sessionId: string }) {
  const sandbox = React.useContext(MarkdownSandbox);
  const [near, setNear] = React.useState(false);
  const [thumb, setThumb] = React.useState<{ path: string; source?: string; note?: string } | null>(null);
  const [served, setServed] = React.useState<{ path: string; url: string } | null>(null);
  // The path that could not be served: the card falls back to the still picture for it.
  const [failed, setFailed] = React.useState<string | null>(null);
  const box = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<HTMLIFrameElement>(null);
  const path = artifact.path;
  const design = artifactKind(path) === 'design';
  const servable = isServableHtml(path) && typeof window !== 'undefined' && !!window.nekko?.serveHtmlPreview;
  const still = !servable || failed === path;

  React.useEffect(() => {
    if (sandbox || near) return;
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [sandbox, near]);

  // The page runs: served offline with its folder, released when the card goes.
  React.useEffect(() => {
    if (sandbox || !near || !servable) return;
    let active = true;
    let id = '';
    const release = (served: string) => { void window.nekko.releaseHtmlPreview?.(served).catch(() => {}); };
    window.nekko.serveHtmlPreview!(path, { internet: false }).then(s => {
      if (!s?.url) throw new Error('not served');
      if (!active) { release(s.id); return; }
      id = s.id;
      setServed({ path, url: s.url });
    }).catch(() => { if (active) setFailed(path); });
    return () => { active = false; if (id) release(id); };
  }, [path, sandbox, near, servable]);

  // Only a page that cannot run is read, to draw it still.
  React.useEffect(() => {
    if (sandbox || !near || !still) return;
    let active = true;
    void window.nekko.readFile(path).then(file => {
      if (active) setThumb({ path, ...htmlThumbnail(file) });
    }).catch(() => { if (active) setThumb({ path, note: 'Could not read the page' }); });
    return () => { active = false; };
  }, [path, sandbox, near, still]);

  const current = !sandbox && still && thumb?.path === path ? thumb : null;
  const source = current?.source;
  const live = !sandbox && !still && served?.path === path ? served.url : '';

  // Scale the desktop-sized page to the card's width, whatever the card's width.
  React.useEffect(() => {
    const el = box.current;
    if ((!source && !live) || !el) return;
    const fit = () => { if (frame.current) frame.current.style.transform = `scale(${el.clientWidth / THUMB_VIEWPORT.width})`; };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [source, live]);

  const open = () => { if (!sandbox) useStore.getState().openFilePane(path, sessionId); };
  const note = sandbox ? 'Host file previews are unavailable in Sandbox' : current?.note ?? (near ? 'Loading preview…' : '');
  const frameStyle = { width: THUMB_VIEWPORT.width, height: THUMB_VIEWPORT.height, transformOrigin: '0 0' };

  // A click anywhere on the card opens the page beside the chat (#3212); keyboard users have the Open button.
  return <div className="artifact-card artifact-render-card flex w-full min-w-0 flex-col overflow-hidden rounded-xl border" role="group" aria-label={`${artifact.title}, HTML page`} data-render-card
    onClick={sandbox ? undefined : open} style={{ cursor: sandbox ? 'default' : 'pointer' }}>
    {live
      // The running page plays in the card but takes no clicks, so a click on it opens the page.
      ? <div ref={box} className="artifact-render-thumb relative h-[200px] w-full overflow-hidden" data-render-thumb data-render-live>
        <iframe ref={frame} title={artifact.title} src={live} sandbox={SERVED_PREVIEW_SANDBOX} referrerPolicy="no-referrer" tabIndex={-1}
          className="absolute left-0 top-0 border-0 bg-white" style={{ ...frameStyle, pointerEvents: 'none' }} />
      </div>
      : <div ref={box} className="artifact-render-thumb relative h-[200px] w-full overflow-hidden" data-render-thumb aria-hidden>
        {source
          ? <iframe ref={frame} title={`${artifact.title} thumbnail`} sandbox="" referrerPolicy="no-referrer" tabIndex={-1} loading="lazy"
            srcDoc={isolatedDocument(source)}
            className="absolute left-0 top-0 border-0 bg-white"
            style={{ ...frameStyle, pointerEvents: 'none' }} />
          : <span className="flex h-full items-center justify-center px-4 text-center text-xs text-ink-soft">{note}</span>}
      </div>}
    <div className="flex min-w-0 items-center gap-3 px-3 py-2">
      <span className="artifact-card-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-2xs font-semibold uppercase" aria-hidden>{artifact.filename.split('.').at(-1)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.title}</span><span className="block truncate text-2xs text-ink-soft">{artifact.filename}</span></span>
      <span className="flex shrink-0 items-center gap-2">
        {/* A design can also fill Library, on its canvas with its versions. */}
        {design && <button type="button" className="artifact-card-action rounded-md border px-2 py-1 text-xs disabled:opacity-50" disabled={sandbox} data-open-in-library
          title={sandbox ? 'Host file previews are unavailable in Sandbox' : `Open ${path} in Library, full screen`}
          onClick={(e) => { e.stopPropagation(); if (!sandbox) useStore.getState().openInLibrary(path, sessionId); }}>Open in Library</button>}
        <button type="button" className="artifact-card-action inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50" disabled={sandbox} data-open-card
          title={sandbox ? 'Host file previews are unavailable in Sandbox' : `Open ${path} beside this chat`}
          onClick={(e) => { e.stopPropagation(); open(); }}>Open<GfArrowUpRightIcon className="h-3.5 w-3.5" /></button>
      </span>
    </div>
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
    className="artifact-card group flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2 text-left no-underline"
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

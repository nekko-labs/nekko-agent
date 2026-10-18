import React from 'react';
import type { RemoteImage } from '@nekko-agent/shared';

/**
 * Remote photos in chat. The renderer never points an <img> at a remote URL
 * (its CSP only allows `'self'` and `data:` images); the host fetches the
 * picture under public-only rules (`image:fetch`) and the chat mounts the
 * returned data URL. This module holds the renderer half: which URLs may load
 * without a click, a small cache, and a concurrency cap so a reply with a
 * dozen photos does not open a dozen connections at once.
 */

/** The http(s) URL a markdown image points at, or null for anything else. */
export function remoteImageUrl(src: string): string | null {
  if (!/^https?:\/\//i.test(src) || /[\s\x00-\x1f]/.test(src)) return null;
  try {
    const url = new URL(src);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Text a chat has actually seen from outside the model: tool results (search
 * results, fetched pages, browser output) and the user's own messages. A
 * remote image whose URL appears here loads by itself. One the model wrote
 * out of nowhere waits for a click: a URL invented by the model (or by a page
 * that injected instructions) can carry chat data in its query string, and
 * loading it would send that data to whoever owns the host.
 */
export function remoteImageEvidence(messages: ReadonlyArray<{ role: string; content?: string; toolResult?: { output?: string } }>): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.toolResult?.output) parts.push(m.toolResult.output);
    if ((m.role === 'tool' || m.role === 'user') && m.content) parts.push(m.content);
  }
  return parts.join('\n');
}

/** True when `url` appears verbatim (or HTML/JSON-escaped) in the evidence. */
export function urlSeenIn(evidence: string, url: string, written = url): boolean {
  if (!evidence) return false;
  const forms = new Set([written, url, written.replace(/&/g, '&amp;'), written.replace(/\//g, '\\/')]);
  for (const form of forms) if (form && evidence.includes(form)) return true;
  return false;
}

export interface ChatImageItem {
  /** A data URL already in hand (attachments, local files, fetched photos). */
  src?: string;
  /** The remote address, for fetching, "Copy link" and "Open original". */
  url?: string;
  alt?: string;
}

export interface ChatImagesApi {
  /** May this remote URL load without a click? */
  trusted: (url: string) => boolean;
  /** Open the full photo viewer on `index` of `items`. */
  open: (items: ChatImageItem[], index: number) => void;
  /** The image right-click menu. */
  menu: (e: React.MouseEvent, item: ChatImageItem) => void;
}

/** Provided by the chat pane; absent elsewhere (file viewer, tests), where remote images stay click-to-load. */
export const ChatImages = React.createContext<ChatImagesApi | null>(null);

// --- fetch cache ---

/** Fetches allowed at once, across every chat. */
export const REMOTE_IMAGE_CONCURRENCY = 4;
/** Fetched images kept in memory (data URLs, so a bounded number). */
export const REMOTE_IMAGE_CACHE = 60;

type Fetcher = (url: string) => Promise<RemoteImage>;
const cache = new Map<string, Promise<RemoteImage>>();
const waiting: Array<() => void> = [];
let active = 0;
let fetcher: Fetcher = (url) => window.nekko.fetchRemoteImage(url);

/** Test seam: swap the host call and clear the cache. */
export function setRemoteImageFetcher(next: Fetcher | null): void {
  fetcher = next ?? ((url) => window.nekko.fetchRemoteImage(url));
  cache.clear();
}

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= REMOTE_IMAGE_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** The fetched image for `url`, shared by every card and the viewer. Failures are not cached, so Retry works. */
export function loadRemoteImage(url: string): Promise<RemoteImage> {
  const hit = cache.get(url);
  if (hit) {
    // Refresh its place in the LRU order.
    cache.delete(url);
    cache.set(url, hit);
    return hit;
  }
  const pending = slot(() => fetcher(url));
  cache.set(url, pending);
  pending.catch(() => { if (cache.get(url) === pending) cache.delete(url); });
  while (cache.size > REMOTE_IMAGE_CACHE) cache.delete(cache.keys().next().value!);
  return pending;
}

export type RemoteImageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; image: RemoteImage }
  | { status: 'error'; message: string };

/** Load `url` once `enabled` turns true; `retry` starts it again after a failure. */
export function useRemoteImage(url: string | null, enabled: boolean): [RemoteImageState, () => void] {
  const [state, setState] = React.useState<RemoteImageState>({ status: 'idle' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!url || !enabled) { setState({ status: 'idle' }); return; }
    let live = true;
    setState({ status: 'loading' });
    loadRemoteImage(url).then(
      (image) => { if (live) setState({ status: 'ready', image }); },
      (e: unknown) => { if (live) setState({ status: 'error', message: errorText(e) }); },
    );
    return () => { live = false; };
  }, [url, enabled, attempt]);
  return [state, React.useCallback(() => setAttempt((n) => n + 1), [])];
}

/** The host's reason, without the IPC wrapper's prefix. */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:Remote)?ImageError:\s*/, '').replace(/^Error:\s*/, '') || 'Could not load the image.';
}

/** True once the element has come within a screen of the viewport. */
export function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = React.useRef<T>(null);
  const [near, setNear] = React.useState(false);
  React.useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/** A short, readable name for a remote image: its host. */
export function imageHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** The file name to save a remote image under. */
export function imageFileName(url: string | undefined, mime: string): string {
  const ext = (/^image\/([a-z0-9]+)/i.exec(mime)?.[1] ?? 'png').replace('jpeg', 'jpg');
  let base = '';
  try { base = decodeURIComponent(new URL(url ?? '').pathname.split('/').pop() ?? ''); } catch { /* not a URL */ }
  base = base.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${base || 'nekko-agent-image'}.${ext}`;
}

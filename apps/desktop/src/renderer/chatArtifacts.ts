import { LOCAL_IMAGE_EXT, localImagePath } from './localImages.js';

/** A preview server on this machine that a reply pointed at. */
export interface LivePreview {
  /** What the card opens in the user's browser. */
  url: string;
  /** `localhost:5173`, shown as the card's subtitle with the route. */
  host: string;
  /** `/pricing`, or empty for the root. */
  route: string;
}

export interface ChatArtifact {
  /** The local file path; for a live preview, its URL (the dedupe key either way). */
  path: string;
  title: string;
  filename: string;
  inlineImage?: boolean;
  /** Set for a localhost preview server link, which is not a file. */
  live?: LivePreview;
}

/**
 * A `file://` URL as a local path: percent-decoded, `file:///C:/x` as `C:/x`.
 * Null for anything else, including a `file://server/share` network path.
 */
export function fileUrlPath(href: string): string | null {
  if (!/^file:/i.test(href)) return null;
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== 'file:' || (url.hostname && url.hostname.toLowerCase() !== 'localhost')) return null;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  if (/[\x00-\x1f]/.test(path)) return null;
  if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
  return /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(path) ? path : null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/** An http(s) URL served from this machine (localhost, 127.0.0.1, [::1], 0.0.0.0). */
export function livePreview(href: string): LivePreview | null {
  if (!/^https?:\/\//i.test(href)) return null;
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.username || url.password || !LOOPBACK.has(url.hostname.toLowerCase())) return null;
  // 0.0.0.0 is a bind address; browsers reach the same server as localhost.
  if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
  const route = `${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`;
  return { url: url.href, host: url.host, route };
}

const BARE_LIVE_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#][^\s<>()[\]`"']*)?/gi;

/**
 * Explicit local document/image links and links to a preview server on this
 * machine, never code examples or other network resources.
 */
export function chatArtifacts(text: string, basePath?: string): ChatArtifact[] {
  const out = new Map<string, ChatArtifact>();
  const source = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`\n]*`/g, '');
  const addLive = (href: string, label: string) => {
    const live = livePreview(href);
    if (!live) return;
    const key = live.url.toLowerCase();
    if (!out.has(key)) out.set(key, { path: live.url, title: label || 'Live preview', filename: `${live.host}${live.route}`, live });
  };
  for (const match of source.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g)) {
    const label = match[2].trim();
    const raw = match[3].trim().replace(/^<|>$/g, '');
    if (!match[1] && livePreview(raw)) { addLive(raw, label); continue; }
    const fromUrl = fileUrlPath(raw);
    const href = fromUrl ?? raw;
    const image = LOCAL_IMAGE_EXT.test(href);
    if (image && !localImagePath(href, basePath)) continue;
    if (match[1] && !image) continue;
    if (/^(?:https?:|mailto:|data:|javascript:|file:|#|\\\\|\/\/)/i.test(href)) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) continue;
    if (!/\.(?:md|markdown|html?|svg|png|jpe?g|gif|webp|pdf|csv|json|txt|docx?|xlsx?|pptx?)$/i.test(href)) continue;
    const absolute = /^(?:[a-z]:[\\/]|\/)/i.test(href);
    if (!absolute && !basePath) continue;
    const combined = absolute ? href : `${basePath}/${href}`;
    const parts: string[] = [];
    for (const part of combined.replaceAll('\\', '/').split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    const path = `${combined.startsWith('/') ? '/' : ''}${parts.join('/')}`;
    const filename = parts.at(-1) || href;
    const generic = /^(?:readme|index)(?:\.[a-z]+)?$/i.test(label) || label === filename;
    const fallback = /^(?:readme|index)\./i.test(filename) ? parts.at(-2) || 'Document' : filename.replace(/\.[^.]+$/, '');
    const title = generic ? fallback.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()) : label;
    // Only an image the reply itself draws (Markdown shows file:// images as text) is inline.
    const inline = !!match[1] && !fromUrl;
    const key = path.toLowerCase();
    const previous = out.get(key);
    if (!previous) out.set(key, { path, title: title || filename, filename, ...(inline ? { inlineImage: true } : {}) });
    else if (inline) previous.inlineImage = true;
  }
  // A bare URL the reply prints (`Server running at http://localhost:5173`).
  for (const match of source.replace(/!?\[[^\]\n]*\]\([^)\n]+\)/g, '').matchAll(BARE_LIVE_URL)) addLive(match[0].replace(/[.,;:!?]+$/, ''), '');
  return [...out.values()];
}

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

/** Outputs worth a preview when a reply only names them: pages, pictures, PDFs. */
const OUTPUT_EXT = /\.(?:html?|svg|png|jpe?g|gif|webp|pdf)$/i;
const OUTPUT_PATH = String.raw`(?:[a-z]:[\\/]|\.{1,2}[\\/]|\/)?[\w.-]+(?:[\\/][\w.-]+)*\.(?:html?|svg|png|jpe?g|gif|webp|pdf)`;
/**
 * A path on its own in prose (`Saved to reports/strip.html.`), never part of a
 * URL or a longer name. It needs a folder: a bare `index.html` in a sentence is
 * talk about a file, not a pointer to one.
 */
const BARE_OUTPUT = new RegExp(String.raw`(?<![\w./\\:-])(${OUTPUT_PATH})(?![\w/\\-]|\.\w)`, 'gi');

/**
 * A code span that is exactly one local page, image or PDF path
 * (`reports/strip-design.html`): the reply names a file it made, so it is a
 * link. Source files, commands and URLs in code stay code.
 */
export function namedOutputPath(code: string): string | null {
  const text = code.trim();
  const fromUrl = fileUrlPath(text);
  if (fromUrl) return OUTPUT_EXT.test(fromUrl) ? text : null;
  return new RegExp(`^${OUTPUT_PATH}$`, 'i').test(text) ? text : null;
}

/** Same length, so match positions still give the reply's order. */
const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/**
 * Local document/image links and links to a preview server on this machine,
 * never code examples or other network resources. A page, image or PDF the
 * reply only names, as a code span or a bare path, counts like a link to it.
 */
export function chatArtifacts(text: string, basePath?: string): ChatArtifact[] {
  const out = new Map<string, ChatArtifact>();
  const source = text.replace(/```[\s\S]*?(?:```|$)/g, blank);
  const prose = source.replace(/`[^`\n]*`/g, blank);
  const addLive = (href: string, label: string) => {
    const live = livePreview(href);
    if (!live) return;
    const key = live.url.toLowerCase();
    if (!out.has(key)) out.set(key, { path: live.url, title: label || 'Live preview', filename: `${live.host}${live.route}`, live });
  };
  const addFile = (raw: string, label: string, imageMarkdown: boolean) => {
    const fromUrl = fileUrlPath(raw);
    const href = fromUrl ?? raw;
    const image = LOCAL_IMAGE_EXT.test(href);
    if (image && !localImagePath(href, basePath)) return;
    if (imageMarkdown && !image) return;
    if (/^(?:https?:|mailto:|data:|javascript:|file:|#|\\\\|\/\/)/i.test(href)) return;
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return;
    if (!/\.(?:md|markdown|html?|svg|png|jpe?g|gif|webp|pdf|csv|json|txt|docx?|xlsx?|pptx?)$/i.test(href)) return;
    const absolute = /^(?:[a-z]:[\\/]|\/)/i.test(href);
    if (!absolute && !basePath) return;
    const combined = absolute ? href : `${basePath}/${href}`;
    const parts: string[] = [];
    for (const part of combined.replaceAll('\\', '/').split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    const path = `${combined.startsWith('/') ? '/' : ''}${parts.join('/')}`;
    const filename = parts.at(-1) || href;
    const generic = !label || /^(?:readme|index)(?:\.[a-z]+)?$/i.test(label) || label === filename || label === raw;
    const fallback = /^(?:readme|index)\./i.test(filename) ? parts.at(-2) || 'Document' : filename.replace(/\.[^.]+$/, '');
    const title = generic ? fallback.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()) : label;
    // Only an image the reply itself draws (Markdown shows file:// images as text) is inline.
    const inline = imageMarkdown && !fromUrl;
    const key = path.toLowerCase();
    const previous = out.get(key);
    if (!previous) out.set(key, { path, title: title || filename, filename, ...(inline ? { inlineImage: true } : {}) });
    else if (inline) previous.inlineImage = true;
  };
  // Every way a reply can point at a file, taken in the order the reply reads.
  const found: { at: number; add: () => void }[] = [];
  for (const match of prose.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g)) {
    const label = match[2].trim();
    const raw = match[3].trim().replace(/^<|>$/g, '');
    const add = !match[1] && livePreview(raw) ? () => addLive(raw, label) : () => addFile(raw, label, !!match[1]);
    found.push({ at: match.index, add });
  }
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    const named = namedOutputPath(match[1]);
    if (named) found.push({ at: match.index, add: () => addFile(named, '', false) });
  }
  const plain = prose.replace(/!?\[[^\]\n]*\]\([^)\n]+\)/g, blank);
  for (const match of plain.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']*/gi, blank).matchAll(BARE_OUTPUT)) {
    if (/[\\/]/.test(match[1])) found.push({ at: match.index, add: () => addFile(match[1], '', false) });
  }
  for (const { add } of found.sort((a, b) => a.at - b.at)) add();
  // A bare URL the reply prints (`Server running at http://localhost:5173`).
  for (const match of plain.matchAll(BARE_LIVE_URL)) addLive(match[0].replace(/[.,;:!?]+$/, ''), '');
  return [...out.values()];
}

import type { FileContent } from '@nekko-agent/shared';
import { localImageData, LOCAL_IMAGE_EXT } from '../../localImages.js';

export const THUMBNAIL_EDGE = 640;
const DOCUMENT_EXT = /\.(?:md|markdown|txt)$/i;
export function thumbnailKind(path: string): 'document' | 'image' | null {
  return DOCUMENT_EXT.test(path) ? 'document' : LOCAL_IMAGE_EXT.test(path) ? 'image' : null;
}

/** Source is always text inside an inert image, never HTML in the app's DOM. */
const xml = (text: string) => text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const inlineText = (text: string) => text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '');

/** A bounded first page, not a full Markdown viewer: no media, links, scripts or fonts. */
export function documentThumbnail(path: string, file: FileContent): string | null {
  if (file.binary || !file.content.slice(0, 24_000).trim()) return null;
  const markdown = !/\.txt$/i.test(path);
  const lines = file.content.slice(0, 24_000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').split(/\r?\n/).slice(0, 160);
  const output: string[] = [];
  let y = 42, code = false, frontmatter = markdown && lines[0]?.trim() === '---';
  for (let i = 0; i < lines.length && y < 770; i++) {
    let line = lines[i];
    if (frontmatter) { if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false; continue; }
    if (markdown && /^\s*(```|~~~)/.test(line)) { code = !code; y += 8; continue; }
    if (!line.trim()) { y += 10; continue; }
    if (markdown && !code && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)) continue;
    const heading = markdown && !code ? /^(#{1,6})\s+(.+)$/.exec(line) : null;
    const size = heading ? (heading[1].length === 1 ? 25 : 18) : 13;
    if (heading) { line = heading[2]; y += 10; }
    if (markdown && !code) line = inlineText(line).replace(/^\s*[-+]\s+/, '• ').replace(/^\s*>\s?/, '');
    // Wrapping also splits long unbroken tokens; a malicious line cannot grow the SVG.
    const columns = heading ? 38 : 74;
    const words = Array.from(line.trim().replace(/\s+/g, ' '));
    while (words.length && y < 770) {
      let end = Math.min(columns, words.length);
      if (end < words.length) { const space = words.slice(0, end).lastIndexOf(' '); if (space > columns / 2) end = space; }
      const text = words.splice(0, end).join('').trim();
      output.push(`<text x="36" y="${y}" font-size="${size}"${heading ? ' font-weight="700"' : ''}${code ? ' font-family="monospace"' : ''}>${xml(text)}</text>`);
      y += heading ? size * 1.3 : 21;
    }
    if (heading) y += 8;
  }
  if (!output.length) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800" viewBox="0 0 640 800"><rect width="640" height="800" fill="#faf9f6"/><g fill="#26232c" font-family="system-ui,sans-serif">${output.join('')}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type Record = { value: string | null; expires: number; bytes: number };
export interface ThumbnailCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  concurrency?: number;
  ttl?: number;
  failureTtl?: number;
  now?: () => number;
}

/** Renderer-local only: bounded LRU, shared in-flight jobs and a small read/decode queue. */
export function createThumbnailCache(loader: (path: string) => Promise<string | null>, options: ThumbnailCacheOptions = {}) {
  const { maxEntries = 80, maxBytes = 8 * 1024 * 1024, concurrency = 3, ttl = 60_000, failureTtl = 5_000, now = Date.now } = options;
  const entries = new Map<string, Record>();
  const pending = new Map<string, Promise<string | null>>();
  const queue: Array<() => void> = [];
  let active = 0, bytes = 0;
  const keyOf = (path: string, revision: string | number = '') => JSON.stringify([path, revision]);
  const remove = (key: string) => { const entry = entries.get(key); if (entry) bytes -= entry.bytes; entries.delete(key); };
  const peek = (path: string, revision?: string | number): string | null | undefined => {
    const key = keyOf(path, revision), entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now()) { remove(key); return undefined; }
    entries.delete(key); entries.set(key, entry);
    return entry.value;
  };
  const drain = () => { while (active < Math.max(1, concurrency) && queue.length) { active++; queue.shift()!(); } };
  const load = (path: string, revision?: string | number): Promise<string | null> => {
    const cached = peek(path, revision);
    if (cached !== undefined) return Promise.resolve(cached);
    const key = keyOf(path, revision), existing = pending.get(key);
    if (existing) return existing;
    const promise = new Promise<string | null>(resolve => {
      queue.push(() => {
        void Promise.resolve().then(() => loader(path)).catch(() => null).then(value => {
          const cost = (value?.length ?? 0) * 2;
          if (cost <= maxBytes && maxEntries > 0) {
            remove(key);
            entries.set(key, { value, bytes: cost, expires: now() + (value ? ttl : failureTtl) }); bytes += cost;
            while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value!);
          }
          pending.delete(key); active--; resolve(value); drain();
        });
      });
    });
    pending.set(key, promise); drain();
    return promise;
  };
  return { peek, load };
}

/** Store a small still picture, not the original multi-megabyte image or animation. */
async function resizeImage(source: string): Promise<string | null> {
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) return null;
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.8);
}

export const thumbnailCache = createThumbnailCache(async path => {
  const kind = thumbnailKind(path);
  if (!kind) return null;
  const file = await window.nekko.readFile(path);
  if (kind === 'document') return documentThumbnail(path, file);
  const source = localImageData(path, file);
  return source ? resizeImage(source) : null;
});

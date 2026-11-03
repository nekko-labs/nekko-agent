/**
 * What an upload may contain, and how each file is served back.
 *
 * Published artifacts are static: HTML, CSS, JS, images, fonts, media, PDFs
 * and data files. A type outside this list is still stored, but served as a
 * download (`application/octet-stream` with `Content-Disposition:
 * attachment`), never rendered.
 */

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
};

export const DOWNLOAD_TYPE = 'application/octet-stream';

/** The served `Content-Type` for a path, or `DOWNLOAD_TYPE` for anything unlisted. */
export function contentType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return DOWNLOAD_TYPE;
  return TYPES[name.slice(dot + 1).toLowerCase()] ?? DOWNLOAD_TYPE;
}

/** Most path segments a file may have; deep enough for any real bundle. */
const MAX_DEPTH = 16;
const MAX_PATH = 512;

/**
 * Why `path` can't be stored, or `null` when it can. A path is relative and
 * `/`-separated, with no empty, `.` or `..` segment, no backslash, no control
 * characters and no segment that starts with `.` (so `.htaccess`, `.git` and
 * `.env` never get published by accident).
 */
export function pathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'a file has no path';
  if (path.length > MAX_PATH) return `a path is longer than ${MAX_PATH} characters`;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return `"${printable(path)}" has a backslash or a control character`;
  const segments = path.split('/');
  if (segments.length > MAX_DEPTH) return `"${path}" is nested more than ${MAX_DEPTH} folders deep`;
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return `"${path}" is not a plain relative path`;
    if (s.startsWith('.')) return `"${path}" names a hidden file or folder`;
  }
  return null;
}

function printable(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, '?');
}

/** An artifact id: 26 lowercase base32 characters (130 bits), unguessable. */
export const ID_PATTERN = /^[a-z2-7]{26}$/;

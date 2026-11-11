import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, relative } from 'node:path';
import { isServableHtml, phoneFilesSecret, type HtmlPreviewOptions } from '@nekko-agent/shared';

/**
 * Serves a local HTML page together with its folder, so a design that links
 * its own stylesheets, scripts, images and fonts renders as it would in a
 * browser (a `srcdoc` frame can load none of them).
 *
 * Each page gets its own unguessable path prefix, and only files under that
 * page's folder are served: no hidden files or folders, nothing that looks
 * like a secret, only web asset types, nothing reached through a link that
 * leaves the folder. A folder that is a disk root or the home folder is
 * refused outright. Every response carries a Content-Security-Policy that
 * keeps the page on this server unless its preview allowed the internet, and
 * then only `https:`/`wss:`, never another local service.
 *
 * The page is meant to be framed with `sandbox="allow-scripts"` (no
 * `allow-same-origin`): its origin is opaque, so it can read no cookie or
 * storage of the app that shows it, even on the same host. Files are
 * therefore sent with `Access-Control-Allow-Origin: *` (module scripts,
 * fonts and fetches from an opaque origin are CORS requests; the secret path
 * is the capability), and HTML gets a small in-memory `localStorage` stand-in,
 * since the real one throws in an opaque origin and would stop most scripts.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

/** Largest single file served. */
export const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024;
/** HTML larger than this is sent as it is, without the storage stand-in. */
const MAX_REWRITE_BYTES = 5 * 1024 * 1024;
/** Pages kept servable at once; the oldest goes first. */
export const MAX_SERVED_PAGES = 32;

const LOCAL_SOURCES = "'self' data: blob:";
const INTERNET_SOURCES = 'https:';

/** The policy every response of a page carries. */
export function previewPolicy(internet: boolean): string {
  const net = internet ? ` ${INTERNET_SOURCES}` : '';
  return [
    `default-src ${LOCAL_SOURCES}${net}`,
    `script-src ${LOCAL_SOURCES} 'unsafe-inline' 'unsafe-eval'${net}`,
    `style-src ${LOCAL_SOURCES} 'unsafe-inline'${net}`,
    `img-src ${LOCAL_SOURCES}${net}`,
    `font-src ${LOCAL_SOURCES}${net}`,
    `media-src ${LOCAL_SOURCES}${net}`,
    `connect-src ${LOCAL_SOURCES}${internet ? ` ${INTERNET_SOURCES} wss:` : ''}`,
    `frame-src ${LOCAL_SOURCES}${net}`,
    `worker-src ${LOCAL_SOURCES}`,
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'self'",
  ].join('; ');
}

/** Inserted first in every served page: storage that works in an opaque origin. */
export const STORAGE_SHIM = "<script>(()=>{const s=()=>{const m=new Map();return{get length(){return m.size},key:i=>[...m.keys()][i]??null,getItem:k=>m.has(String(k))?m.get(String(k)):null,setItem:(k,v)=>{m.set(String(k),String(v))},removeItem:k=>{m.delete(String(k))},clear:()=>m.clear()}};for(const n of['localStorage','sessionStorage']){try{void window[n]}catch{try{Object.defineProperty(window,n,{value:s(),configurable:true})}catch{}}}})()</script>";

/** The page with the stand-in after its doctype (before it would force quirks mode). */
export function withStorageShim(html: string): string {
  // A single forward scan (no backtracking regex): byte-order mark, then
  // whitespace and comments, then the doctype.
  let i = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipSpace = () => { while (i < html.length && /\s/.test(html[i])) i++; };
  skipSpace();
  while (html.startsWith('<!--', i)) {
    const end = html.indexOf('-->', i + 4);
    if (end < 0) return STORAGE_SHIM + html;
    i = end + 3;
    skipSpace();
  }
  if (html.slice(i, i + 9).toLowerCase() !== '<!doctype') return STORAGE_SHIM + html;
  const close = html.indexOf('>', i);
  if (close < 0) return STORAGE_SHIM + html;
  return html.slice(0, close + 1) + STORAGE_SHIM + html.slice(close + 1);
}

/** The path without separators at its end, by a plain scan. */
function trimSeparators(path: string): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end--;
  return path.slice(0, end);
}

export class HtmlPreviewRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HtmlPreviewRefusal';
  }
}

interface Page {
  folder: string;
  internet: boolean;
}

export interface HtmlPreviewServerOptions {
  /** Address to listen on. Default 127.0.0.1. */
  host?: string;
  /** Port to listen on. Default: any free one. */
  port?: number;
  /** The home folder, refused as a page folder. Default `os.homedir()`. */
  home?: string;
}

export interface HtmlPreviewServe {
  id: string;
  port: number;
  /** `/<id>/<page>`: join it to the host the browser reaches. */
  path: string;
}

export interface HtmlPreviewServer {
  serve(file: string, options: HtmlPreviewOptions): Promise<HtmlPreviewServe>;
  release(id: string): void;
  close(): Promise<void>;
}

const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const sameFolder = (a: string, b: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Why a relative path may not be served, or undefined when it may. */
function refusedPath(rel: string): string | undefined {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p.startsWith('.'))) return 'hidden';
  if (phoneFilesSecret(rel)) return 'secret';
  const ext = extname(rel).toLowerCase();
  if (!MIME[ext]) return 'type';
  return undefined;
}

export function createHtmlPreviewServer(options: HtmlPreviewServerOptions = {}): HtmlPreviewServer {
  const pages = new Map<string, Page>();
  let listening: Promise<{ server: Server; port: number }> | undefined;
  const home = options.home ?? homedir();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const fail = (status: number) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(status === 404 ? 'Not found' : status === 405 ? 'Method not allowed' : 'Refused');
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405);
    const raw = (req.url ?? '/').split(/[?#]/)[0];
    const [, id, ...rest] = raw.split('/');
    const page = id ? pages.get(id) : undefined;
    if (!page) return fail(404);
    let parts: string[];
    try {
      parts = rest.map(decodeURIComponent);
    } catch {
      return fail(400);
    }
    // A decoded segment never carries a separator: `..%2F` must not climb out.
    if (parts.some((p) => p === '..' || p === '.' || /[\\/\0]/.test(p))) return fail(400);
    let target = join(page.folder, ...parts);
    let real: string;
    try {
      real = await realpath(target);
      if ((await stat(real)).isDirectory()) {
        target = join(target, 'index.html');
        real = await realpath(target);
      }
    } catch {
      return fail(404);
    }
    if (!inside(page.folder, real)) return fail(403);
    const rel = relative(page.folder, real);
    if (refusedPath(rel)) return fail(403);
    let size: number;
    try {
      const info = await stat(real);
      if (!info.isFile()) return fail(404);
      size = info.size;
    } catch {
      return fail(404);
    }
    if (size > MAX_PREVIEW_FILE_BYTES) return fail(413);
    const type = MIME[extname(real).toLowerCase()];
    const headers: Record<string, string | number> = {
      'Content-Type': type,
      'Content-Security-Policy': previewPolicy(page.internet),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (type.startsWith('text/html') && size <= MAX_REWRITE_BYTES) {
      let body: Buffer;
      try {
        body = Buffer.from(withStorageShim((await readFile(real)).toString('utf8')), 'utf8');
      } catch {
        return fail(404);
      }
      res.writeHead(200, { ...headers, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };

  const listen = () => {
    listening ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        handle(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); });
      });
      server.once('error', (e) => { listening = undefined; reject(e); });
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { server.close(); listening = undefined; reject(new Error('Preview server has no port.')); return; }
        resolve({ server, port: address.port });
      });
    });
    return listening;
  };

  return {
    async serve(file, { internet }) {
      if (typeof file !== 'string' || !file || file.includes('\0')) throw new HtmlPreviewRefusal('Preview needs a file path.');
      if (!isServableHtml(file)) throw new HtmlPreviewRefusal('Only .html and .htm pages are served.');
      let real: string;
      try {
        real = await realpath(file);
        if (!(await stat(real)).isFile()) throw new Error('not a file');
      } catch {
        throw new HtmlPreviewRefusal('That page no longer exists.');
      }
      const folder = dirname(real);
      const root = parse(folder).root;
      let realHome = home;
      try { realHome = await realpath(home); } catch { /* keep as given */ }
      if (sameFolder(folder, root) || sameFolder(trimSeparators(folder), trimSeparators(realHome))) {
        throw new HtmlPreviewRefusal('Pages directly in a disk root or the home folder are not served; move it into a folder of its own.');
      }
      const why = refusedPath(basename(real));
      if (why) throw new HtmlPreviewRefusal(why === 'hidden' ? 'Hidden pages are not served.' : 'That page is not served.');
      const { port } = await listen();
      const id = randomBytes(18).toString('base64url');
      pages.set(id, { folder, internet: internet === true });
      while (pages.size > MAX_SERVED_PAGES) pages.delete(pages.keys().next().value as string);
      return { id, port, path: `/${id}/${encodeURIComponent(basename(real))}` };
    },
    release(id) {
      if (typeof id === 'string') pages.delete(id);
    },
    async close() {
      pages.clear();
      const current = listening;
      listening = undefined;
      if (!current) return;
      const { server } = await current.catch(() => ({ server: undefined }));
      if (!server) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

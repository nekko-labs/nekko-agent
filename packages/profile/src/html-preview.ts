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

/**
 * Inserted after the storage stand-in when the design canvas asked for it
 * (`controls`): the page answers its viewer, and only its viewer, over
 * `postMessage` with its scroll size and what is moving, and pauses or
 * resumes all of it (CSS animations and transitions, Web Animations,
 * `requestAnimationFrame` loops, video and audio). The design takes clicks and
 * hover itself, so the script also passes the canvas the gestures that move it:
 * a scroll the page has no scroll box for, any pinch or Ctrl/Cmd+scroll, and
 * Space held down (outside a field or button) to drag. It tells the frame
 * above nothing else, and takes nothing from it but the three commands.
 */
export const CONTROL_SHIM = "<script>(()=>{if(window.parent===window)return;const raf=window.requestAnimationFrame.bind(window),caf=window.cancelAnimationFrame.bind(window);let paused=false,frames=0,seq=0;const held=new Map(),playing=new Set();window.requestAnimationFrame=cb=>{frames++;if(!paused)return raf(cb);const id=-(++seq);held.set(id,cb);return id};window.cancelAnimationFrame=id=>{if(id<0)held.delete(id);else caf(id)};const anims=()=>{try{return document.getAnimations().filter(a=>a.playState==='running'||a.playState==='paused')}catch{return[]}};const media=()=>[...document.querySelectorAll('video,audio')];const tell=()=>{const d=document.documentElement,b=document.body;window.parent.postMessage({nekkoPreview:'state',animations:anims().length,media:media().length,frames,paused,width:Math.max(d.scrollWidth,b?b.scrollWidth:0),height:Math.max(d.scrollHeight,b?b.scrollHeight:0)},'*')};addEventListener('message',e=>{if(e.source!==window.parent||!e.data||typeof e.data.nekkoPreview!=='string')return;const c=e.data.nekkoPreview;if(c==='pause'&&!paused){paused=true;anims().forEach(a=>{try{a.pause()}catch{}});media().forEach(m=>{if(!m.paused){playing.add(m);m.pause()}})}else if(c==='play'&&paused){paused=false;anims().forEach(a=>{try{a.play()}catch{}});playing.forEach(m=>{m.play().catch(()=>{})});playing.clear();const q=[...held.values()];held.clear();q.forEach(cb=>raf(cb))}if(c==='pause'||c==='play'||c==='probe')tell()});addEventListener('load',tell);const room=(d,s,c,t,o)=>d!==0&&/(auto|scroll)/.test(o)&&s>c+1&&(d>0?t+c<s-1:t>0);const scrolls=(el,dx,dy)=>{for(;el&&el.nodeType===1&&el!==document.body&&el!==document.documentElement;el=el.parentElement){let st;try{st=window.getComputedStyle(el)}catch{continue}if(room(dy,el.scrollHeight,el.clientHeight,el.scrollTop,st.overflowY)||room(dx,el.scrollWidth,el.clientWidth,el.scrollLeft,st.overflowX))return true}return false};addEventListener('wheel',e=>{const zoom=!!(e.ctrlKey||e.metaKey);if(!zoom&&scrolls(e.target,e.deltaX,e.deltaY))return;e.preventDefault();const k=e.deltaMode===1?16:e.deltaMode===2?800:1;window.parent.postMessage({nekkoPreview:'wheel',dx:e.deltaX*k,dy:e.deltaY*k,x:e.clientX,y:e.clientY,zoom},'*')},{passive:false});let hand=false;const grab=down=>{if(down!==hand){hand=down;window.parent.postMessage({nekkoPreview:'hand',down},'*')}};const field=t=>!!t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName||''));addEventListener('keydown',e=>{if(e.code==='Space'&&!field(e.target)){e.preventDefault();grab(true)}});addEventListener('keyup',e=>{if(e.code==='Space')grab(false)});addEventListener('blur',()=>grab(false))})()</script>";

/** The page with the stand-in (and `extra`) after its doctype (before it would force quirks mode). */
export function withStorageShim(html: string, extra = ''): string {
  const shim = STORAGE_SHIM + extra;
  // A single forward scan (no backtracking regex): byte-order mark, then
  // whitespace and comments, then the doctype.
  let i = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipSpace = () => { while (i < html.length && /\s/.test(html[i])) i++; };
  skipSpace();
  while (html.startsWith('<!--', i)) {
    const end = html.indexOf('-->', i + 4);
    if (end < 0) return shim + html;
    i = end + 3;
    skipSpace();
  }
  if (html.slice(i, i + 9).toLowerCase() !== '<!doctype') return shim + html;
  const close = html.indexOf('>', i);
  if (close < 0) return shim + html;
  return html.slice(0, close + 1) + shim + html.slice(close + 1);
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
  controls: boolean;
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
        body = Buffer.from(withStorageShim((await readFile(real)).toString('utf8'), page.controls ? CONTROL_SHIM : ''), 'utf8');
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
    async serve(file, { internet, controls }) {
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
      pages.set(id, { folder, internet: internet === true, controls: controls === true });
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

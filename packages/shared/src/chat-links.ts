/**
 * What an agent linked in a chat (issue #1095): the local files it made and
 * the local preview servers it started, read from the chat's assistant
 * messages. A paired phone may open exactly these through `artifact:read` and
 * `preview:fetch` (phone-artifacts.ts), so this is a security boundary: the
 * computer serves what the agent linked in that chat, nothing else.
 *
 * - **Artifacts**: Markdown links and images, `[label](href)` / `![alt](href)`,
 *   outside fenced and inline code, the rules of the desktop's
 *   `chatArtifacts` (apps/desktop/src/renderer/chatArtifacts.ts) plus `file://`
 *   URLs (percent-decoded; `file:///C:/...` on Windows) and absolute paths. A
 *   relative href resolves against the chat's folder when it has one. Only
 *   document and image extensions (`CHAT_LINK_EXT`).
 * - **Loopback origins**: `http(s)://localhost|127.0.0.1|0.0.0.0|[::1]` with an
 *   optional port, anywhere in an assistant message outside fenced code
 *   (inline code counts: agents often write the dev server's address as
 *   `http://localhost:5173`). `localhost`, `127.0.0.1` and `0.0.0.0` are one
 *   origin (`localhost`); `[::1]` is its own.
 *
 * The daemon has the same rules (crates/nekko-remote/src/chat_links.rs), held
 * to these by the shared cases in crates/nekko-remote/tests/golden/phone-artifacts.json
 * (phone-artifacts.golden.test.ts writes them with UPDATE_GOLDEN=1).
 */

/** Extensions a linked artifact may have: documents and images. */
export const CHAT_LINK_EXT = [
  'csv', 'doc', 'docx', 'gif', 'htm', 'html', 'jpeg', 'jpg', 'json', 'markdown', 'md', 'pdf', 'png', 'ppt', 'pptx',
  'svg', 'txt', 'webp', 'xls', 'xlsx',
] as const;

/**
 * Extensions of the files a linked HTML page may load from its own folder
 * (stylesheets, scripts, data, images, fonts, source maps, other pages). No
 * WebAssembly, archives, executables or anything else.
 */
export const CHAT_ASSET_EXT = [
  'avif', 'css', 'csv', 'gif', 'htm', 'html', 'ico', 'jpeg', 'jpg', 'js', 'json', 'map', 'md', 'mjs', 'otf', 'png',
  'svg', 'ttf', 'txt', 'webp', 'woff', 'woff2',
] as const;

/** Host names that are this computer; the first three are one origin. */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'] as const;

/** What one chat linked: artifact paths (normalised, absolute) and loopback origins (`http://localhost:5173`). */
export interface ChatLinks {
  artifacts: string[];
  origins: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text with fenced code blocks removed (an unclosed fence runs to the end). */
export function withoutFences(text: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('```', i);
    if (open < 0) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf('```', open + 3);
    if (close < 0) return out;
    i = close + 3;
  }
}

/** Text with inline code spans (one line, between single backticks) removed. */
export function withoutInlineCode(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== '`' && text[j] !== '\n') j++;
      if (j < text.length && text[j] === '`') {
        i = j + 1;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/** The hrefs of Markdown links and images in `text`, in order: `[label](href)`. */
export function markdownHrefs(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '[') {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length && text[j] !== ']' && text[j] !== '\n') j++;
    if (j >= text.length || text[j] !== ']' || text[j + 1] !== '(') {
      i++;
      continue;
    }
    const start = j + 2;
    let k = start;
    while (k < text.length && text[k] !== ')' && text[k] !== '\n') k++;
    if (k >= text.length || text[k] !== ')' || k === start) {
      i++;
      continue;
    }
    out.push(text.slice(start, k));
    i = k + 1;
  }
  return out;
}

/** `decodeURIComponent`, or null on a malformed escape. */
function percentDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The path of a `file:` URL (`file:///home/a`, `file://localhost/a`, `file:/a`, `file:///C:/a`), or null. */
function fileUrlPath(url: string): string | null {
  let rest = url.slice(5);
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2);
    if (slash < 0) return null;
    const host = rest.slice(2, slash).toLowerCase();
    if (host !== '' && host !== 'localhost') return null;
    rest = rest.slice(slash);
  }
  if (!rest.startsWith('/')) return null;
  const decoded = percentDecode(rest);
  if (decoded === null) return null;
  return /^\/[a-z]:(?:[\\/]|$)/i.test(decoded) ? decoded.slice(1) : decoded;
}

/**
 * A link or a phone's path as a normalised absolute path on this computer
 * (`/a/b` or `C:/a/b`, `\` as `/`, `.` and `..` resolved lexically), or null:
 * a `file:` URL (local only), an absolute path, or a path relative to `base`.
 * A query or fragment is dropped. Other URL schemes, UNC shares, control
 * characters and Windows alternate data streams are refused.
 */
export function localPath(href: string, base?: string): string | null {
  let p = href.trim().replace(/^</, '').replace(/>$/, '');
  if (/^file:/i.test(p)) {
    const f = fileUrlPath(p);
    if (f === null) return null;
    p = f;
  } else {
    if (/^(?:\\|\/\/)/.test(p) || p.startsWith('#')) return null;
    if (/^[a-z][a-z\d+.-]*:/i.test(p) && !/^[a-z]:[\\/]/i.test(p)) return null;
    const cut = p.search(/[?#]/);
    if (cut >= 0) p = p.slice(0, cut);
  }
  if (p === '' || /[\u0000-\u001f\u007f]/.test(p)) return null;
  const absolute = /^(?:[a-z]:[\\/]|\/)/i.test(p);
  if (!absolute && !base) return null;
  const combined = (absolute ? p : `${base}/${p}`).replace(/\\/g, '/');
  if (combined.startsWith('//') || (!/^[a-z]:\//i.test(combined) && !combined.startsWith('/'))) return null;
  const parts: string[] = [];
  for (const part of combined.split('/')) {
    if (part === '..') {
      if (parts.length && !/^[a-z]:$/i.test(parts[parts.length - 1])) parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  const path = `${combined.startsWith('/') ? '/' : ''}${parts.join('/')}`;
  if (/[\u0000-\u001f\u007f]/.test(path) || path.replace(/^[a-z]:/i, '').includes(':')) return null;
  return path;
}

/** The lowercase extension of a path's last segment, or ''. */
export function pathExt(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** A Markdown link's target as an artifact path, or null when it is not a local document or image. */
export function linkArtifactPath(href: string, base?: string): string | null {
  const path = localPath(href, base);
  return path !== null && (CHAT_LINK_EXT as readonly string[]).includes(pathExt(path)) ? path : null;
}

/** A parsed loopback URL: its origin (`http://localhost:5173`), the authority as sent, and path plus query. */
export interface LoopbackUrl {
  origin: string;
  scheme: 'http' | 'https';
  /** The authority as written, host lowercased: the `Host` header the computer sends. */
  authority: string;
  port: number;
  /** `localhost` (also `127.0.0.1` and `0.0.0.0`) or `[::1]`. */
  host: 'localhost' | '[::1]';
  /** Path and query, starting `/`; the fragment is dropped. */
  path: string;
  /** The URL rebuilt from the checked parts. */
  url: string;
}

/** Where a loopback URL's host ends and its port begins, from `i` (just after `://`); null when the host is not loopback. */
function loopbackHost(text: string, i: number): { host: 'localhost' | '[::1]'; end: number } | null {
  for (const name of LOOPBACK_HOSTS) {
    if (text.slice(i, i + name.length).toLowerCase() === name) return { host: name === '[::1]' ? '[::1]' : 'localhost', end: i + name.length };
  }
  return null;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * A URL a phone may ask the computer to fetch: `http` or `https`, a loopback
 * host, an optional port (1 to 65535), no user info, no whitespace or
 * backslash, at most `maxChars` long. Null for anything else.
 */
export function loopbackUrl(url: string, maxChars = 2048): LoopbackUrl | null {
  if (url.length > maxChars || /[\u0000-\u0020\u007f\\]/.test(url)) return null;
  const lower = url.slice(0, 8).toLowerCase();
  const scheme = lower.startsWith('https://') ? 'https' : lower.startsWith('http://') ? 'http' : null;
  if (!scheme) return null;
  const at = scheme.length + 3;
  let end = url.slice(at).search(/[/?#]/);
  end = end < 0 ? url.length : at + end;
  const authority = url.slice(at, end).toLowerCase();
  if (authority.includes('@')) return null;
  const h = loopbackHost(authority, 0);
  if (!h) return null;
  let port = scheme === 'https' ? 443 : 80;
  if (h.end < authority.length) {
    const digits = authority.slice(h.end + 1);
    if (authority[h.end] !== ':' || !/^\d{1,5}$/.test(digits)) return null;
    port = Number(digits);
    if (port < 1 || port > 65535) return null;
  }
  let path = url.slice(end);
  const hash = path.indexOf('#');
  if (hash >= 0) path = path.slice(0, hash);
  if (!path.startsWith('/')) path = `/${path}`;
  return { origin: `${scheme}://${h.host}:${port}`, scheme, authority, port, host: h.host, path, url: `${scheme}://${authority}${path}` };
}

/**
 * The loopback origins in `text`, in order, once each. After the host and an
 * optional port, the next character must end the address (not a letter,
 * digit, `_`, `-`, `:`, `@`, nor `.` when there is no port), so
 * `http://localhost.example.com` and `http://localhost@example.com` are not
 * this computer.
 */
export function loopbackOrigins(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== 'h' && text[i] !== 'H') continue;
    const lower = text.slice(i, i + 8).toLowerCase();
    const scheme = lower.startsWith('https://') ? 'https' : lower.startsWith('http://') ? 'http' : null;
    if (!scheme) continue;
    const h = loopbackHost(text, i + scheme.length + 3);
    if (!h) continue;
    let j = h.end;
    let port = scheme === 'https' ? 443 : 80;
    const hasPort = text[j] === ':' && isDigit(text[j + 1]);
    if (hasPort) {
      let k = j + 1;
      while (isDigit(text[k])) k++;
      if (k - (j + 1) > 5) continue;
      port = Number(text.slice(j + 1, k));
      if (port < 1 || port > 65535) continue;
      j = k;
    }
    const next = text[j];
    if (next !== undefined && (/[A-Za-z0-9_\-:@]/.test(next) || (!hasPort && next === '.'))) continue;
    const origin = `${scheme}://${h.host}:${port}`;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The artifacts and loopback origins one assistant message links. */
export function messageLinks(text: string, base?: string): ChatLinks {
  const prose = withoutFences(text);
  const artifacts: string[] = [];
  for (const href of markdownHrefs(withoutInlineCode(prose))) {
    const path = linkArtifactPath(href, base);
    if (path !== null && !artifacts.includes(path)) artifacts.push(path);
  }
  return { artifacts, origins: loopbackOrigins(prose) };
}

/**
 * What a chat's assistant messages link (`messages` is `session.messages`;
 * `base` the chat's folder, when it has one). Other roles never count: a
 * user's or a tool's text can't open anything to a phone.
 */
export function chatLinks(messages: unknown, base?: string): ChatLinks {
  const out: ChatLinks = { artifacts: [], origins: [] };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!isObj(m) || m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const one = messageLinks(m.content, base);
    for (const a of one.artifacts) if (!out.artifacts.includes(a)) out.artifacts.push(a);
    for (const o of one.origins) if (!out.origins.includes(o)) out.origins.push(o);
  }
  return out;
}

/** Why a path may be read: it is a linked artifact, or a file in a linked HTML page's folder (`root`). */
export interface ArtifactAccess {
  kind: 'linked' | 'asset';
  /** The linked artifact itself, or the folder of the linked page. */
  root: string;
}

/**
 * Whether a normalised path may be read for this chat's links: equal to a
 * linked artifact, or inside the folder of a linked `.html`/`.htm` page with
 * an asset extension (`CHAT_ASSET_EXT`) and no dot-folder or dot-file on the
 * way (`.git`, `.cache`, `.env`). A page at a filesystem root opens no folder.
 * `caseInsensitive` compares the way Windows and macOS file names do.
 */
export function artifactAccess(path: string, links: ChatLinks, caseInsensitive: boolean): ArtifactAccess | null {
  const key = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const want = key(path);
  const linked = links.artifacts.find((a) => key(a) === want);
  if (linked !== undefined) return { kind: 'linked', root: linked };
  if (!(CHAT_ASSET_EXT as readonly string[]).includes(pathExt(path))) return null;
  for (const a of links.artifacts) {
    const ext = pathExt(a);
    if (ext !== 'html' && ext !== 'htm') continue;
    const dir = a.slice(0, a.lastIndexOf('/'));
    // `/page.html` or `C:/page.html`: the root of a disk is not a page's folder.
    if (dir === '' || /^[a-z]:$/i.test(dir)) continue;
    const prefix = `${key(dir)}/`;
    if (!want.startsWith(prefix)) continue;
    const rel = want.slice(prefix.length).split('/');
    if (rel.some((s) => s.startsWith('.'))) continue;
    return { kind: 'asset', root: dir };
  }
  return null;
}

/**
 * Files and logs from a paired phone (IO-33 FA-1, FA-5): which arguments a
 * phone may send to `files:*` and `logs:*`, and what it receives back. The
 * engine is the computer's (packages/shared/src/files.ts, logs.ts; served by
 * nekkod); this is the phone's narrower view of it.
 *
 * - A phone names a folder by chat or saved-folder id (`{ sessionId }`,
 *   `{ sessionId, workspaceId }` or `{ workspaceId }`), never by path; the
 *   computer resolves it and refuses anything outside it.
 * - Arguments are rebuilt from the checked fields, so nothing else reaches the
 *   computer's call; reads and log tails are capped lower than the desktop's.
 * - Saving needs the hash the phone read (`expectHash`): a phone never creates
 *   a file and never overwrites a newer edit on the computer unseen.
 * - Secret-looking files (the IO-9 rule plus git's stored credentials and a
 *   repository's config) are refused before the computer is asked, left out
 *   of listings and search results (counted in `hiddenSecrets`), and never
 *   returned, whatever the engine answered.
 * - Logs are read only and already redacted by the computer; the phone gets a
 *   capped tail or capped matches.
 *
 * The daemon has the same rules (crates/nekko-remote/src/phone_files.rs), held
 * to these by the shared cases in crates/nekko-remote/tests/golden/phone-files.json
 * (phone-files.golden.test.ts writes them with UPDATE_GOLDEN=1).
 */

import { phoneSecretFile } from './phone-changes.js';

/** The limits of a phone's files and logs. */
export const PHONE_FILES_VIEW = {
  /** Entries in one folder listing. */
  entries: 500,
  /** Search results. */
  hits: 100,
  /** Search results when the phone names no limit. */
  hitsDefault: 50,
  /** Bytes of text a phone may read at once (the computer's default read). */
  readBytes: 256 * 1024,
  /** UTF-16 units of an image's data URL (a 2 MB image is about 2.8 M). */
  imageChars: 3 * 1024 * 1024,
  /** UTF-8 bytes a phone may save: only what it could read whole. */
  writeBytes: 256 * 1024,
  /** UTF-16 units of a relative path, an id, or a search query. */
  pathChars: 1024,
  idChars: 200,
  queryChars: 200,
  /** Logs listed. */
  logs: 120,
  /** Bytes of a log's tail a phone may ask for; a search may look further back. */
  logTailBytes: 256 * 1024,
  logSearchBytes: 8 * 1024 * 1024,
  /** Matching lines, and UTF-16 units kept of each. */
  logMatches: 500,
  logLineChars: 2000,
  /** UTF-16 units of a tail the phone receives (its end is kept). */
  logTextChars: 256 * 1024,
} as const;

/** Read-class channels: looking only. */
export const PHONE_FILES_READ_CHANNELS = ['files:list', 'files:read', 'files:search', 'logs:list', 'logs:read'] as const;

/** Change-class channels: saving a file. */
export const PHONE_FILES_CHANGE_CHANNELS = ['files:write'] as const;

export const PHONE_FILES_CHANNELS: readonly string[] = [...PHONE_FILES_READ_CHANNELS, ...PHONE_FILES_CHANGE_CHANNELS];

/** Fields of a listing entry a phone receives. */
export const PHONE_FILE_ENTRY_VIEW = ['dir', 'link', 'mtime', 'name', 'path', 'size'] as const;
/** Fields of a read file a phone receives (`content` and `imageDataUrl` are capped). */
export const PHONE_FILE_VIEW = ['editable', 'hash', 'kind', 'language', 'markdown', 'mime', 'mtime', 'name', 'path', 'size', 'truncated'] as const;
/** Fields of a save's answer. */
export const PHONE_FILE_WRITE_VIEW = ['error', 'hash', 'mtime', 'ok', 'size'] as const;
/** Fields of a log in the list. */
export const PHONE_LOG_VIEW = ['id', 'kind', 'sessionId', 'size', 'title', 'updatedAt'] as const;

/** Why a phone's files or logs call is refused: the gate turns it into a `PhoneAccessError`. */
export class PhoneFilesRefusal extends Error {
  constructor(
    readonly code: 'value-invalid' | 'option-denied',
    readonly detail: string,
  ) {
    super(detail);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const bad = (detail: string) => new PhoneFilesRefusal('value-invalid', detail);
const V = PHONE_FILES_VIEW;

/**
 * A path relative to the folder whose content never goes to a phone:
 * `phoneSecretFile`, plus git's stored credentials and a repository's config
 * (a remote URL can carry a token). The computer's own rule (`secret_path` in
 * crates/nekko-workspace/src/scoped.rs) is the same.
 */
export function phoneFilesSecret(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase();
  const name = p.slice(p.lastIndexOf('/') + 1);
  return phoneSecretFile(p) || name === '.git-credentials' || p === '.git/config' || p.endsWith('/.git/config');
}

/** A folder whose contents are all secret (`.ssh`, `.aws`, `.gnupg`). */
function secretDir(path: string): boolean {
  return path !== '' && phoneFilesSecret(`${path}/x`);
}

/** The folder: `{ sessionId }`, `{ sessionId, workspaceId }` or `{ workspaceId }`, rebuilt. */
function root(v: unknown): Obj {
  if (!isObj(v)) throw bad('folder');
  for (const key of Object.keys(v)) {
    if (key !== 'sessionId' && key !== 'workspaceId') throw new PhoneFilesRefusal('option-denied', key);
  }
  const out: Obj = {};
  for (const key of ['sessionId', 'workspaceId']) {
    if (!own(v, key)) continue;
    const id = v[key];
    if (typeof id !== 'string' || id === '' || id.length > V.idChars) throw bad('folder');
    out[key] = id;
  }
  if (Object.keys(out).length === 0) throw bad('folder');
  return out;
}

/** A relative path: text without NUL, not too long. `''` is the folder itself when `empty` allows it. */
function relPath(v: unknown, empty: boolean): string {
  if (v === undefined && empty) return '';
  if (typeof v !== 'string' || v.length > V.pathChars || v.includes('\0') || (!empty && v === '')) throw bad('path');
  return v;
}

/** A whole number of at least 1, clamped to `max`. */
function count(v: unknown, what: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad(what);
  return Math.min(v, max);
}

/** An options object (or nothing) with only `keys`. */
function options(v: unknown, keys: readonly string[], what: string): Obj {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw bad(what);
  for (const key of Object.keys(v)) {
    if (!keys.includes(key)) throw new PhoneFilesRefusal('option-denied', key);
  }
  return v;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * The arguments to pass to the computer's call, rebuilt from the checked
 * fields, or a `PhoneFilesRefusal`.
 */
export function screenPhoneFiles(channel: string, args: unknown[]): unknown[] {
  switch (channel) {
    case 'files:list':
      return [root(args[0]), relPath(args[1], true)];
    case 'files:search': {
      const r = root(args[0]);
      const q = args[1];
      if (typeof q !== 'string' || q.trim() === '' || q.length > V.queryChars) throw bad('query');
      const limit = args[2] === undefined || args[2] === null ? V.hitsDefault : count(args[2], 'limit', V.hits);
      return [r, q, limit];
    }
    case 'files:read': {
      const r = root(args[0]);
      const p = relPath(args[1], false);
      if (phoneFilesSecret(p)) throw bad('secret file');
      const o = options(args[2], ['maxBytes'], 'read options');
      const maxBytes = own(o, 'maxBytes') ? count(o.maxBytes, 'maxBytes', V.readBytes) : V.readBytes;
      return [r, p, { maxBytes }];
    }
    case 'files:write': {
      const r = root(args[0]);
      const p = relPath(args[1], false);
      if (phoneFilesSecret(p)) throw bad('secret file');
      const content = args[2];
      if (typeof content !== 'string') throw bad('content');
      if (utf8Bytes(content) > V.writeBytes) throw bad('content too large');
      const o = options(args[3], ['expectHash'], 'save options');
      // A phone saves over the version it read, never blind and never a new file.
      if (typeof o.expectHash !== 'string' || !/^[0-9a-f]{64}$/.test(o.expectHash)) throw bad('expectHash');
      return [r, p, content, { expectHash: o.expectHash }];
    }
    case 'logs:list':
      return [];
    case 'logs:read': {
      const id = args[0];
      if (typeof id !== 'string' || id === '' || id.length > V.idChars) throw bad('log id');
      const o = options(args[1], ['maxMatches', 'query', 'tailBytes'], 'log options');
      const out: Obj = {};
      if (own(o, 'query')) {
        if (typeof o.query !== 'string' || o.query.length > V.queryChars) throw bad('query');
        if (o.query !== '') out.query = o.query;
      }
      if (own(o, 'tailBytes')) out.tailBytes = count(o.tailBytes, 'tailBytes', own(out, 'query') ? V.logSearchBytes : V.logTailBytes);
      if (own(o, 'maxMatches')) out.maxMatches = count(o.maxMatches, 'maxMatches', V.logMatches);
      return [id, out];
    }
    default:
      throw bad(channel);
  }
}

function pick(value: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (own(value, k)) out[k] = value[k];
  return out;
}

/** A count the computer sent, or 0. */
const num = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** `s` cut to `n` UTF-16 units, never leaving half of a surrogate pair. */
function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** The last `n` UTF-16 units of `s`, never starting with half of a surrogate pair. */
function tailText(s: string, n: number): string {
  if (s.length <= n) return s;
  let start = s.length - n;
  const c = s.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff) start++;
  return s.slice(start);
}

function listingView(r: unknown): unknown {
  if (!isObj(r)) return null;
  const out = pick(r, ['hiddenLinks', 'path', 'total']);
  let hidden = num(r.hiddenSecrets);
  const entries: Obj[] = [];
  for (const e of Array.isArray(r.entries) ? r.entries : []) {
    if (!isObj(e) || typeof e.path !== 'string') continue;
    if (e.dir === true ? secretDir(e.path) : phoneFilesSecret(e.path)) {
      hidden++;
      continue;
    }
    entries.push(pick(e, PHONE_FILE_ENTRY_VIEW));
  }
  out.entries = entries.slice(0, V.entries);
  out.truncated = r.truncated === true || entries.length > V.entries;
  out.hiddenSecrets = hidden;
  return out;
}

function searchView(r: unknown): unknown {
  if (!isObj(r)) return null;
  const hits: Obj[] = [];
  for (const h of Array.isArray(r.hits) ? r.hits : []) {
    if (!isObj(h) || typeof h.path !== 'string' || phoneFilesSecret(h.path)) continue;
    hits.push(pick(h, ['name', 'path']));
  }
  return { hits: hits.slice(0, V.hits), truncated: r.truncated === true || hits.length > V.hits, complete: r.complete === true };
}

function fileView(r: unknown): unknown {
  if (!isObj(r) || typeof r.path !== 'string' || phoneFilesSecret(r.path)) return null;
  const out = pick(r, PHONE_FILE_VIEW);
  if (typeof r.content === 'string') {
    if (r.content.length > V.readBytes) {
      out.content = cutText(r.content, V.readBytes);
      out.truncated = true;
      out.editable = false;
    } else out.content = r.content;
  }
  if (typeof r.imageDataUrl === 'string' && r.imageDataUrl.startsWith('data:image/') && r.imageDataUrl.length <= V.imageChars) {
    out.imageDataUrl = r.imageDataUrl;
  }
  return out;
}

function logReadView(r: unknown): unknown {
  if (!isObj(r)) return null;
  const out = pick(r, ['id', 'moreMatches', 'query', 'size', 'truncated', 'updatedAt']);
  if (typeof r.text === 'string') {
    out.text = tailText(r.text, V.logTextChars);
    if (r.text.length > V.logTextChars) out.truncated = true;
  }
  if (Array.isArray(r.matches)) {
    const matches = r.matches.filter(isObj);
    out.matches = matches.slice(0, V.logMatches).map((m) => ({ line: m.line, text: typeof m.text === 'string' ? cutText(m.text, V.logLineChars) : '' }));
    if (matches.length > V.logMatches) out.moreMatches = true;
  }
  return out;
}

/** What a phone receives for a files or logs call. */
export function phoneFilesView(channel: string, result: unknown): unknown {
  switch (channel) {
    case 'files:list':
      return listingView(result);
    case 'files:search':
      return searchView(result);
    case 'files:read':
      return fileView(result);
    case 'files:write':
      return isObj(result) ? pick(result, PHONE_FILE_WRITE_VIEW) : null;
    case 'logs:list':
      return Array.isArray(result) ? result.filter(isObj).slice(0, V.logs).map((l) => pick(l, PHONE_LOG_VIEW)) : [];
    case 'logs:read':
      return logReadView(result);
    default:
      return null;
  }
}

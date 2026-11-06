/**
 * What the agent linked, opened on a paired phone (issue #1095): which
 * arguments a phone may send to `artifact:read` and `preview:fetch`, and what
 * it receives back. Both are read class.
 *
 * - `artifact:read [sessionId, path]`: a file the agent linked in that chat
 *   (chat-links.ts), or a file a linked HTML page loads from its own folder.
 *   `path` is absolute or a `file:` URL, exactly as linked or derived by the
 *   phone from a linked page; it is normalised here and the computer checks it
 *   against the chat's links, its real path (symlinks) and the secret-file
 *   rule. Text up to `textBytes` comes as `content` (longer text is cut, with
 *   `truncated`), anything else up to `binaryBytes` as `base64` (larger: no
 *   body, `truncated`).
 * - `preview:fetch [sessionId, url, { method }]`: a GET or HEAD to a local
 *   preview server whose origin the agent linked in that chat. The computer
 *   connects to 127.0.0.1 / ::1 only, sends no cookies, credentials or phone
 *   headers, follows at most `redirects` redirects inside the same origin,
 *   gives up after `timeoutMs` and returns at most `previewBytes` of body.
 *
 * Arguments are rebuilt from the checked fields; an unknown option is
 * `option-denied`, a bad value `value-invalid`. The daemon has the same rules
 * (crates/nekko-remote/src/phone_artifacts.rs) held to these by
 * crates/nekko-remote/tests/golden/phone-artifacts.json; nekkod serves the
 * calls (crates/nekkod/src/artifacts.rs).
 */

import { localPath, loopbackUrl } from './chat-links.js';
import { phoneFilesSecret } from './phone-files.js';

export const PHONE_ARTIFACTS_VIEW = {
  /** UTF-8 bytes of text returned as `content`. */
  textBytes: 1024 * 1024,
  /** Bytes of any other file returned as `base64`. */
  binaryBytes: 4 * 1024 * 1024,
  /** Bytes of a preview response body. */
  previewBytes: 4 * 1024 * 1024,
  /** UTF-16 units of a path, a URL, a chat id. */
  pathChars: 4096,
  urlChars: 2048,
  idChars: 200,
  /** Redirects followed inside the linked origin. */
  redirects: 5,
  /** How long a preview fetch may take, redirects included. */
  timeoutMs: 15_000,
} as const;

/** Read-class channels: looking only. */
export const PHONE_ARTIFACT_READ_CHANNELS = ['artifact:read', 'preview:fetch'] as const;
export const PHONE_ARTIFACT_CHANNELS: readonly string[] = [...PHONE_ARTIFACT_READ_CHANNELS];

/** Fields of `artifact:read` a phone receives, besides the capped `content` / `base64`. */
export const PHONE_ARTIFACT_VIEW = ['kind', 'mime', 'mtime', 'name', 'path', 'size', 'truncated'] as const;
/** Fields of `preview:fetch` a phone receives, besides `headers` and the capped `base64`. */
export const PHONE_PREVIEW_VIEW = ['contentType', 'status', 'truncated', 'url'] as const;
/** The response headers a phone receives (lowercase). */
export const PHONE_PREVIEW_HEADERS = ['cache-control', 'content-length', 'content-type', 'etag', 'last-modified'] as const;
export const PHONE_PREVIEW_METHODS = ['GET', 'HEAD'] as const;

/** Why a phone's artifact or preview call is refused: the gate turns it into a `PhoneAccessError`. */
export class PhoneArtifactsRefusal extends Error {
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
const bad = (detail: string) => new PhoneArtifactsRefusal('value-invalid', detail);
const V = PHONE_ARTIFACTS_VIEW;

function chatId(v: unknown): string {
  if (typeof v !== 'string' || v === '' || v.length > V.idChars) throw bad('chat id');
  return v;
}

/** The arguments to pass to the computer's call, rebuilt from the checked fields, or a `PhoneArtifactsRefusal`. */
export function screenPhoneArtifacts(channel: string, args: unknown[]): unknown[] {
  switch (channel) {
    case 'artifact:read': {
      const id = chatId(args[0]);
      const raw = args[1];
      // Absolute only: the phone sends what was linked, or a path it derived from a linked page.
      const path = typeof raw === 'string' && raw.length <= V.pathChars ? localPath(raw) : null;
      if (path === null) throw bad('path');
      if (phoneFilesSecret(path)) throw bad('secret file');
      if (args.length > 2) throw new PhoneArtifactsRefusal('option-denied', 'extra argument');
      return [id, path];
    }
    case 'preview:fetch': {
      const id = chatId(args[0]);
      const parsed = typeof args[1] === 'string' ? loopbackUrl(args[1], V.urlChars) : null;
      if (parsed === null) throw bad('url');
      const o = args[2];
      let method = 'GET';
      if (o !== undefined && o !== null) {
        if (!isObj(o)) throw bad('preview options');
        for (const key of Object.keys(o)) if (key !== 'method') throw new PhoneArtifactsRefusal('option-denied', key);
        if (own(o, 'method')) {
          if (!(PHONE_PREVIEW_METHODS as readonly unknown[]).includes(o.method)) throw bad('method');
          method = o.method as string;
        }
      }
      if (args.length > 3) throw new PhoneArtifactsRefusal('option-denied', 'extra argument');
      return [id, parsed.url, { method }];
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

/** UTF-16 units of the base64 of `bytes` bytes. */
const base64Chars = (bytes: number) => Math.ceil(bytes / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** `s` cut to `n` UTF-16 units, never leaving half of a surrogate pair. */
function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

function artifactView(r: unknown): unknown {
  if (!isObj(r) || typeof r.path !== 'string' || phoneFilesSecret(r.path)) return null;
  const out = pick(r, PHONE_ARTIFACT_VIEW);
  if (typeof r.content === 'string') {
    if (r.content.length > V.textBytes) {
      out.content = cutText(r.content, V.textBytes);
      out.truncated = true;
    } else out.content = r.content;
  }
  if (typeof r.base64 === 'string') {
    if (r.base64.length <= base64Chars(V.binaryBytes) && BASE64.test(r.base64)) out.base64 = r.base64;
    else out.truncated = true;
  }
  return out;
}

function previewView(r: unknown): unknown {
  if (!isObj(r)) return null;
  const out = pick(r, PHONE_PREVIEW_VIEW);
  const headers: Obj = {};
  if (isObj(r.headers)) {
    for (const k of PHONE_PREVIEW_HEADERS) if (typeof r.headers[k] === 'string') headers[k] = r.headers[k];
  }
  out.headers = headers;
  if (typeof r.base64 === 'string') {
    if (r.base64.length <= base64Chars(V.previewBytes) && BASE64.test(r.base64)) out.base64 = r.base64;
    else out.truncated = true;
  }
  return out;
}

/** What a phone receives for an artifact or preview call. */
export function phoneArtifactsView(channel: string, result: unknown): unknown {
  switch (channel) {
    case 'artifact:read':
      return artifactView(result);
    case 'preview:fetch':
      return previewView(result);
    default:
      return null;
  }
}

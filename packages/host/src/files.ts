import { assertHostExecution } from './indirect-execution-guard.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, extname } from 'path';
import type { DirEntry, FileContent } from '@nekko-agent/shared';

/**
 * Direct, user-initiated file access for the in-app file explorer, viewer, and
 * editor. Unlike the agent's tools these are driven by explicit user clicks, so
 * they aren't sandbox-jailed, the user browses and edits their own projects.
 */

/** Editor read cap (1 MB), large files load partially. */
const MAX_READ = 1_000_000;

/** Read a file as text; flags binary (NUL byte present) and truncation. */
export function readFile(path: string, sessionId?: string): FileContent {
  assertHostExecution(sessionId, 'Host file access');
  if (!existsSync(path) || statSync(path).isDirectory()) {
    return { content: '', truncated: false, binary: false };
  }
  const size = statSync(path).size;
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[extname(path).toLowerCase()];
  if (mime && size > 8_000_000) return { content: '', truncated: true, binary: true };
  const buf = readFileSync(path);
  const signature = mime === 'image/png' ? buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/jpeg' ? buf[0] === 255 && buf[1] === 216 && buf[2] === 255
    : mime === 'image/gif' ? /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))
    : mime === 'image/webp' ? buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' : false;
  if (mime && signature) return { content: '', binary: true, truncated: false, imageDataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
  const slice = buf.subarray(0, Math.min(buf.length, MAX_READ));
  if (slice.includes(0)) return { content: '', truncated: false, binary: true };
  return { content: slice.toString('utf8'), truncated: buf.length > MAX_READ, binary: false };
}

/** Write text to a file, creating parent directories as needed. */
export function writeFile(path: string, content: string, sessionId?: string): void {
  assertHostExecution(sessionId, 'Host file write');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** Pasted attachments are capped so a stray paste cannot fill the data dir. */
const MAX_IMPORT = 50_000_000;

/**
 * Save bytes the user pasted into the composer (a PDF copied from a browser, a
 * file from an email) as a real file under `<dataDir>/attachments/<session>/`,
 * so it can be attached like anything picked from disk. The name is reduced to
 * a safe basename, and a clash gets a numeric suffix rather than overwriting.
 */
export function importAttachment(dataDir: string, sessionId: string, name: string, dataUrl: string): string {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) throw new Error('Attachment must be a base64 data URL.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_IMPORT) throw new Error('Attachment is larger than 50 MB.');
  const safeSession = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'chat';
  const dir = join(dataDir, 'attachments', safeSession);
  mkdirSync(dir, { recursive: true });
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim() || 'pasted';
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let target = join(dir, base);
  for (let n = 2; existsSync(target); n += 1) target = join(dir, `${stem}-${n}${ext}`);
  writeFileSync(target, bytes);
  return target;
}

/** List a directory's entries, directories first then files (alphabetical). */
export function listDir(path: string, sessionId?: string): DirEntry[] {
  assertHostExecution(sessionId, 'Host file access');
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .map((e) => ({ name: e.name, path: join(path, e.name), dir: e.isDirectory() }))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
}

import { existsSync, readFileSync } from 'fs';
import type { FileChange } from '@nekko-agent/shared';
import { daemonCall } from './engine/daemon.js';
import { daemonOwns } from './daemon-caps.js';

/**
 * Tracks files the agent changes during a session so the user can review and
 * approve/revert them (Devin-style). The first time a path is written/edited in
 * a session we snapshot its original content; the diff is always current-on-disk
 * vs that snapshot. Writes still happen immediately (no disruption to the agent
 * loop), "revert" simply writes content back. In-memory only.
 *
 * When the engine daemon keeps the list (`changes:*`, crates/nekkod), every
 * function here uses it, so the tools it runs itself and the ones this host
 * runs share one list; the daemon calls back `changes:notify` on each change.
 */

interface Rec { path: string; original: string }

const bySession = new Map<string, Map<string, Rec>>();
let notify: ((sessionId: string) => void) | null = null;

/** Wire a callback that fires (with the sessionId) whenever a session's set changes. */
export function setChangeNotifier(fn: (sessionId: string) => void): void {
  notify = fn;
}

async function daemon() {
  const call = daemonCall();
  return call && (await daemonOwns(call, 'changes:record')) ? call : undefined;
}

/** The daemon changed a session's set (`changes:notify`). */
export function notifyChanges(sessionId: string): void {
  notify?.(sessionId);
}

/** Snapshot a file's original content the first time it's touched this session. */
export async function recordOriginal(sessionId: string | undefined, path: string): Promise<void> {
  if (!sessionId) return;
  const d = await daemon();
  if (d) return void (await d('changes:record', sessionId, path));
  let m = bySession.get(sessionId);
  if (!m) { m = new Map(); bySession.set(sessionId, m); }
  if (m.has(path)) return;
  const original = existsSync(path) ? safeRead(path) : '';
  m.set(path, { path, original });
  notify?.(sessionId);
}

/** Files actually different from their snapshot, for this session. */
export async function listChanges(sessionId: string): Promise<FileChange[]> {
  const d = await daemon();
  if (d) return d<FileChange[]>('changes:list', sessionId);
  const m = bySession.get(sessionId);
  if (!m) return [];
  const out: FileChange[] = [];
  for (const rec of m.values()) {
    const current = existsSync(rec.path) ? safeRead(rec.path) : '';
    if (current !== rec.original) out.push({ path: rec.path, original: rec.original, current });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Accept (keep) a file's changes, stop tracking it. */
export async function acceptChange(sessionId: string, path: string): Promise<void> {
  const d = await daemon();
  if (d) return void (await d('changes:accept', sessionId, path));
  bySession.get(sessionId)?.delete(path);
  notify?.(sessionId);
}

/** Accept all of a session's changes. */
export async function acceptAllChanges(sessionId: string): Promise<void> {
  const d = await daemon();
  if (d) return void (await d('changes:acceptAll', sessionId));
  bySession.delete(sessionId);
  notify?.(sessionId);
}

function safeRead(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

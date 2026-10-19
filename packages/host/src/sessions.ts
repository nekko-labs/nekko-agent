import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { readFile, readdir, stat } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import type { QueuePayload, QueuedPrompt, Session, SessionSummary } from '@nekko-agent/shared';
import { archiveExpired, clientMessageIdOf, hasClientMessageId, queueItemsEqual, rememberClientMessageIds, summarizeSession, getExecutionMode, defaultSavedMode, sessionPatchForMode } from '@nekko-agent/shared';
import { dataDir, getSettings } from './store.js';
import { deleteAgentLog } from './agent-log.js';

function sessionsDir(): string {
  const dir = join(dataDir(), 'sessions');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const pathFor = (id: string) => join(sessionsDir(), `${id}.json`);

export function listSessions(): Session[] {
  return readdirSync(sessionsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(sessionsDir(), f), 'utf8')) as Session;
      } catch {
        return null;
      }
    })
    .filter((s): s is Session => !!s)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Summaries by file path, valid while the file's mtime and size still match.
 *
 * Keyed by the full path rather than the id so data dirs never share entries
 * (the cloud edition serves several). Writes through this module refresh their
 * entry directly; anything else that touches a file (another process on the
 * same data dir) shows up as a changed mtime and is re-read.
 */
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: SessionSummary }>();

function remember(file: string, session: Session): void {
  try {
    const st = statSync(file);
    summaryCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary: summarizeSession(session) });
  } catch {
    summaryCache.delete(file);
  }
}

/**
 * Every chat without its transcript, newest first.
 *
 * Asynchronous on purpose: this runs on every sidebar refresh, and in the
 * desktop app the host shares a thread with the window's IPC. Only files that
 * changed since the last call are read and parsed; the rest come from the cache.
 */
export async function listSessionSummaries(): Promise<SessionSummary[]> {
  const dir = sessionsDir();
  const names = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const live = new Set<string>();
  const out = await Promise.all(
    names.map(async (name): Promise<SessionSummary | null> => {
      const file = join(dir, name);
      live.add(file);
      try {
        const st = await stat(file);
        const hit = summaryCache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
        const summary = summarizeSession(JSON.parse(await readFile(file, 'utf8')) as Session);
        summaryCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
        return summary;
      } catch {
        return null;
      }
    }),
  );
  for (const file of summaryCache.keys()) if (file.startsWith(dir) && !live.has(file)) summaryCache.delete(file);
  return out.filter((s): s is SessionSummary => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(id: string): Session | null {
  if (!existsSync(pathFor(id))) return null;
  try {
    return JSON.parse(readFileSync(pathFor(id), 'utf8')) as Session;
  } catch {
    return null;
  }
}

/**
 * Write a chat whole or not at all: to a temp file beside it, then renamed
 * over it. The engine daemon reads these files concurrently (it serves the
 * session lists and opens), and an in-place write could hand it half a file.
 */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows refuses a rename over a file another process has open without
      // delete sharing (an antivirus scan, an editor); that clears in moments.
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 20) {
        rmSync(tmp, { force: true });
        throw e;
      }
      const until = Date.now() + 5 * (attempt + 1);
      while (Date.now() < until) { /* a few ms, synchronously: saveSession is sync */ }
    }
  }
}

/**
 * What the user owns on a chat, as opposed to what a running turn owns (the
 * transcript, the model it ran on, the plan it keeps, an automatic title).
 * The UI changes these while a turn is running, through the engine daemon or
 * this host; a turn's save must not put back the values it read at its start.
 */
const USER_FIELDS = ['pinned', 'tags', 'order', 'mode', 'disabledTools', 'effort', 'disabledMcpServers', 'disabledConnectors', 'offline', 'incognito', 'executionMode', 'gitIsolation', 'sandbox', 'autoModel', 'autoQuality', 'autoProviderSwitch', 'workMode', 'thinking', 'chatType', 'imageParams', 'workspaceId', 'supportingWorkspaceIds', 'attachedPaths', 'specLinked', 'queue', 'archivedAt'] as const;

/**
 * Save a chat a running turn has held in memory, keeping whatever the user
 * changed on disk since: the fields above as they are on disk, and the title
 * when the user has named the chat themselves (`titleAuto === false`).
 */
export function saveTurnSession(s: Session, queued?: { index: number; item: QueuedPrompt }): void {
  const disk = getSession(s.id);
  if (disk) {
    const target = s as unknown as Record<string, unknown>;
    const source = disk as unknown as Record<string, unknown>;
    for (const key of USER_FIELDS) {
      if (key in source) target[key] = source[key];
      else delete target[key];
    }
    if (disk.titleAuto === false) {
      s.title = disk.title;
      s.titleAuto = false;
    }
    // Ids a phone queued with meanwhile stay remembered beside this turn's own.
    if (disk.clientMessageIds?.length) s.clientMessageIds = rememberClientMessageIds(disk.clientMessageIds, s.clientMessageIds ?? []);
    // Claim the selected queue entry in the same atomic write as its user
    // message. If the queue changed while startup was awaiting IO, leave it
    // intact rather than removing a different prompt.
    if (queued) {
      const item = disk.queue?.[queued.index];
      if (item === undefined || !queueItemsEqual(item, queued.item)) throw new Error('Queued prompt changed before it could start.');
      s.queue = disk.queue!.filter((_, i) => i !== queued.index);
    }
  } else if (queued) {
    throw new Error('Session not found.');
  }
  saveSession(s);
}

/**
 * Land a generated title, unless the user named the chat meanwhile (the
 * title is only the app's while `titleAuto` is true). Landing it also ends
 * generation: the flag stays the "may generate" gate. True when written.
 */
export function applyAutoTitle(id: string, title: string): boolean {
  const fresh = getSession(id);
  if (!fresh || fresh.titleAuto !== true) return false;
  fresh.title = title;
  fresh.titleAuto = false;
  saveSession(fresh);
  return true;
}

export function saveSession(s: Session): void {
  s.updatedAt = Date.now();
  const file = pathFor(s.id);
  writeAtomic(file, JSON.stringify(s, null, 2));
  remember(file, s);
}

export function deleteSession(id: string): void {
  const file = pathFor(id);
  summaryCache.delete(file);
  if (existsSync(file)) rmSync(file);
  // Legacy synchronous callers observe persistence errors through flushAgentLogs.
  void deleteAgentLog(id).catch(() => {});
}

export function setSessionWorkspace(id: string, workspaceId?: string): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.workspaceId = workspaceId;
  if (s.supportingWorkspaceIds?.length) {
    s.supportingWorkspaceIds = s.supportingWorkspaceIds.filter((wid) => wid !== workspaceId);
    if (s.supportingWorkspaceIds.length === 0) s.supportingWorkspaceIds = undefined;
  }
  if (getExecutionMode(s) === 'sandbox') { s.mode = 'ask'; s.gitWorktrees = undefined; }
  saveSession(s);
  return s;
}

export function setSessionSupportingWorkspaces(id: string, workspaceIds: string[]): Session | null {
  const s = getSession(id);
  if (!s) return null;
  const next = Array.from(new Set(workspaceIds.filter((wid) => wid && wid !== s.workspaceId)));
  s.supportingWorkspaceIds = next.length ? next : undefined;
  saveSession(s);
  return s;
}

export function setSessionAttachments(id: string, paths: string[]): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.attachedPaths = paths;
  saveSession(s);
  return s;
}

export function setSpecLinked(id: string, linked: boolean): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.specLinked = linked;
  saveSession(s);
  return s;
}

/** Drop a message and everything after it (used by edit-and-resend). */
export function truncateSession(id: string, messageId: string): Session | null {
  const s = getSession(id);
  if (!s) return null;
  const idx = s.messages.findIndex((m) => m.id === messageId);
  if (idx >= 0) s.messages = s.messages.slice(0, idx);
  saveSession(s);
  return s;
}

/**
 * A new chat holding `id`'s conversation before `beforeMessageId` (the whole
 * transcript when that id is absent), with the same project, folders and brain.
 * The source chat is not touched. Used to split a conversation at a message:
 * the message itself is handed to the new chat's composer by the caller, so
 * the user can edit it before it runs.
 */
export function forkSession(id: string, beforeMessageId?: string): Session | null {
  const src = getSession(id);
  if (!src) return null;
  const idx = beforeMessageId ? src.messages.findIndex((m) => m.id === beforeMessageId) : -1;
  const fork = createSession(src.workspaceId, undefined, src.supportingWorkspaceIds);
  fork.executionMode = getExecutionMode(src);
  fork.gitIsolation = fork.executionMode === 'worktree';
  if (fork.executionMode === 'sandbox') { fork.mode = 'ask'; fork.gitWorktrees = undefined; }
  fork.title = `${src.title} (split)`;
  fork.titleAuto = false;
  fork.messages = structuredClone(idx >= 0 ? src.messages.slice(0, idx) : src.messages);
  for (const key of ['providerId', 'modelId', 'autoModel', 'autoQuality', 'mode', 'thinking', 'chatType', 'imageParams', 'attachedPaths', 'disabledTools', 'effort', 'disabledMcpServers', 'disabledConnectors'] as const) {
    if (src[key] !== undefined) (fork as unknown as Record<string, unknown>)[key] = structuredClone(src[key]);
  }
  if (getExecutionMode(fork) === 'sandbox') fork.mode = 'ask';
  saveSession(fork);
  return fork;
}

/**
 * Delete archived chats that have outlived the retention window. Returns how
 * many went. Run at startup and now and then after, so a chat archived on a
 * machine that is rarely restarted is still gone on time.
 */
export function purgeExpiredArchives(now = Date.now()): number {
  let n = 0;
  for (const s of listSessions()) {
    if (archiveExpired(s, now)) {
      deleteSession(s.id);
      n++;
    }
  }
  return n;
}

/** Delete chats within a time window (today / this month / all). Returns count. */
export function clearSessions(scope: 'today' | 'month' | 'all'): number {
  let cutoff = 0;
  if (scope !== 'all') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (scope === 'month') d.setDate(1);
    cutoff = d.getTime();
  }
  let n = 0;
  for (const s of listSessions()) {
    if (scope === 'all' || s.updatedAt >= cutoff) {
      deleteSession(s.id);
      n++;
    }
  }
  return n;
}

/** The fields `setSessionOptions` may change (crates/nekko-store/src/write.rs keeps the same list). */
const OPTION_KEYS = ['title', 'pinned', 'tags', 'order', 'mode', 'disabledTools', 'effort', 'disabledMcpServers', 'disabledConnectors', 'offline', 'incognito', 'executionMode', 'gitIsolation', 'autoModel', 'autoQuality', 'autoProviderSwitch', 'workMode', 'thinking', 'providerId', 'modelId', 'plan', 'chatType', 'imageParams', 'archivedAt'] as const;

/** Patch per-chat options (title, pin, mode, disabled tools, effort, MCP servers, connectors, offline, incognito, brain, archive). */
export function setSessionOptions(
  id: string,
  patch: Partial<Pick<Session, 'title' | 'pinned' | 'tags' | 'order' | 'mode' | 'disabledTools' | 'effort' | 'disabledMcpServers' | 'disabledConnectors' | 'offline' | 'incognito' | 'executionMode' | 'gitIsolation' | 'autoModel' | 'autoQuality' | 'autoProviderSwitch' | 'workMode' | 'thinking' | 'providerId' | 'modelId' | 'plan' | 'chatType' | 'imageParams' | 'archivedAt'>>,
): Session | null {
  const s = getSession(id);
  if (!s) return null;
  if (patch.executionMode !== undefined && !['sandbox', 'worktree', 'unified'].includes(patch.executionMode)) throw new Error('Invalid execution mode');
  if ((patch as Record<string, unknown>).sandbox !== undefined) throw new Error('Sandbox setup requires the setup route');
  // A renderer may still synchronize the legacy flag after explicit setup.
  const nextMode = patch.executionMode ?? (s.executionMode === 'sandbox' ? 'sandbox' : patch.gitIsolation !== undefined ? (patch.gitIsolation ? 'worktree' : 'unified') : getExecutionMode(s));
  if (nextMode !== getExecutionMode(s) && (s.activeRun || s.messages.length || s.sandbox)) throw new Error('Execution mode can only change in an empty, idle chat. Create a new chat.');
  if (nextMode === 'sandbox') { s.mode = 'ask'; s.gitWorktrees = undefined; }
  if (patch.executionMode !== undefined || patch.gitIsolation !== undefined) { s.executionMode = nextMode; s.gitIsolation = nextMode === 'worktree'; }
  // Only the options this signature names: the patch arrives over the wire, and
  // assigning it whole would let a caller replace any field, the transcript included.
  for (const [key, value] of Object.entries(patch)) {
    if ((OPTION_KEYS as readonly string[]).includes(key)) (s as unknown as Record<string, unknown>)[key] = value;
  }
  if (patch.executionMode !== undefined || patch.gitIsolation !== undefined) { s.executionMode = nextMode; s.gitIsolation = nextMode === 'worktree'; }
  if (getExecutionMode(s) === 'sandbox') s.mode = 'ask';
  // A title the user typed is theirs; the auto-title pass may not overwrite it.
  if (patch.title !== undefined) s.titleAuto = false;
  saveSession(s);
  return s;
}

/** Append a prompt to a chat's run-queue (executed when the current turn ends). */
export function queuePrompt(id: string, input: string | QueuePayload): Session | null {
  const s = getSession(id);
  const payload: QueuePayload = typeof input === 'string' ? { text: input } : input;
  // A resend of a prompt this chat already took (a phone's outbox) changes nothing.
  const clientId = clientMessageIdOf(payload.clientMessageId);
  if (hasClientMessageId(s, clientId)) return s;
  const text = payload.text.trim();
  const images = payload.images?.filter(Boolean) ?? [];
  const videos = payload.videos?.filter(Boolean) ?? [];
  const skill = payload.skill;
  if (!s || (!text && images.length === 0 && videos.length === 0 && !skill)) return s;
  const item: QueuedPrompt = images.length || videos.length || skill
    ? { text, ...(images.length ? { images } : {}), ...(videos.length ? { videos } : {}), ...(skill ? { skill } : {}) }
    : text;
  s.queue = [...(s.queue ?? []), item];
  if (clientId) s.clientMessageIds = rememberClientMessageIds(s.clientMessageIds, [clientId]);
  saveSession(s);
  return s;
}

/** Remove a queued prompt by index. */
export function dequeuePrompt(id: string, index: number): Session | null {
  const s = getSession(id);
  if (!s?.queue) return s ?? null;
  s.queue = s.queue.filter((_, i) => i !== index);
  saveSession(s);
  return s;
}

/**
 * Change or remove a queued prompt before it runs (a phone's queue editor).
 * `expect` is the text the editor showed: when the prompt at `index` no longer
 * has it (it started, or the queue moved), nothing changes and this throws, so
 * an edit never lands on a different prompt. A `text` that is missing, or blank
 * on a prompt with no photos, removes it. A skill's prompt can only be removed:
 * its text is the skill's instructions, which the editor never sees.
 */
export function editQueuedPrompt(id: string, index: number, edit: { expect?: unknown; text?: unknown }): Session | null {
  const s = getSession(id);
  if (!s) return null;
  const item = Number.isInteger(index) ? s.queue?.[index] : undefined;
  const shown = typeof item === 'string' ? item : item?.text;
  if (item === undefined || typeof edit?.expect !== 'string' || shown !== edit.expect) {
    throw new Error('That queued prompt already started or changed.');
  }
  const text = typeof edit.text === 'string' ? edit.text.trim() : undefined;
  const photos = typeof item === 'string' ? 0 : (item.images?.length ?? 0) + (item.videos?.length ?? 0);
  if (text !== undefined && typeof item !== 'string' && item.skill) throw new Error('A skill’s queued prompt can only be removed.');
  const queue = s.queue ?? [];
  if (text === undefined || (!text && !photos)) {
    s.queue = queue.filter((_, i) => i !== index);
  } else {
    s.queue = queue.map((q, i) => (i !== index ? q : typeof q === 'string' ? text : { ...q, text }));
  }
  saveSession(s);
  return s;
}

export function createSession(workspaceId?: string, parentSessionId?: string, supportingWorkspaceIds?: string[]): Session {
  const now = Date.now();
  const s: Session = {
    // Crypto-random suffix, not Math.random: a session id names a file in the
    // data dir and is passed around as a handle, and the remote transport lets
    // one reach the network, so it should not be guessable from a timestamp.
    // Same readable `s_<time>_<rand>` shape as before; ids are never parsed.
    id: `s_${now.toString(36)}_${randomBytes(6).toString('base64url')}`,
    title: parentSessionId ? 'Sub-agent' : 'New chat',
    workspaceId,
    executionMode: parentSessionId ? getExecutionMode(getSession(parentSessionId) ?? undefined) : getSettings().defaultExecutionMode,
    gitIsolation: parentSessionId ? getSession(parentSessionId)?.gitIsolation ?? false : getSettings().gitManagement?.mode !== 'shared',
    gitWorktrees: parentSessionId ? getSession(parentSessionId)?.gitWorktrees : undefined,
    supportingWorkspaceIds: supportingWorkspaceIds?.length ? supportingWorkspaceIds : undefined,
    parentSessionId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  // A top-level chat starts in the user's default saved mode, when they set one.
  const start = parentSessionId ? undefined : defaultSavedMode(getSettings());
  if (start) {
    Object.assign(s, sessionPatchForMode(start.options));
    if (s.executionMode === 'sandbox') s.mode = 'ask';
  }
  saveSession(s);
  return s;
}

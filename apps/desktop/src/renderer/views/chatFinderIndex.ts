/**
 * The chat finder's transcript index: every user and assistant message's text
 * and every artifact a chat produced, per chat, so the finder can search whole
 * conversations rather than the summary alone.
 *
 * Built in the renderer from the text-only view the daemon serves
 * (`finderChatText`: messages and file-naming tool arguments, no pictures,
 * reasoning or tool output, kept per chat file version), so nothing new is
 * stored on disk and a chat's pictures never cross the wire to be searched.
 * Each chat is read once per version: an entry stays valid while the chat's
 * `updatedAt` is unchanged, and the index survives the popup closing, so a
 * second search is a filter over memory.
 */
import type { FinderChatText, Session, SessionSummary } from '@nekko-agent/shared';
import { getCachedSession } from '../sessionCache.js';
import { sessionArtifacts } from '../artifactsIndex.js';
import type { IndexedChat, IndexedMessage } from './chatFinder.js';

/** Chats asked for in one call: text only, so a call stays small. */
const BATCH = 25;
/** Calls in flight at once. */
const PARALLEL = 2;

const index = new Map<string, IndexedChat>();

export function indexChat(session: Pick<Session, 'id' | 'title' | 'messages' | 'updatedAt'>, basePath?: string): IndexedChat {
  const messages: IndexedMessage[] = [];
  for (const m of session.messages ?? []) {
    if ((m.role !== 'user' && m.role !== 'assistant') || !m.content?.trim()) continue;
    const text = m.skill?.input && m.role === 'user' ? `${m.content}\n${m.skill.input}` : m.content;
    messages.push({ id: m.id, role: m.role, at: m.createdAt, text, lower: text.toLowerCase() });
  }
  return { updatedAt: session.updatedAt, messages, artifacts: sessionArtifacts(session, basePath) };
}

/** The index's input for a chat the daemon sent as text only. */
const fromText = (v: FinderChatText): Pick<Session, 'id' | 'title' | 'messages' | 'updatedAt' | 'workspaceId' | 'gitWorktrees'> => ({
  id: v.id ?? '',
  title: v.title,
  updatedAt: v.updatedAt ?? 0,
  workspaceId: v.workspaceId ?? undefined,
  // Only `path` is read from a worktree (`basePathOf`).
  gitWorktrees: v.gitWorktrees as Session['gitWorktrees'],
  // The tool calls carry only name and file arguments, which is all the index reads.
  messages: v.messages.map((m) => ({ ...m, id: m.id ?? '', createdAt: m.createdAt ?? 0 })) as unknown as Session['messages'],
});

/** Where a chat's relative links resolve: its checkout of the primary folder, else that folder. */
export function basePathOf(session: Pick<Session, 'workspaceId' | 'gitWorktrees'>, workspaces: ReadonlyArray<{ id: string; path: string }>): string | undefined {
  if (!session.workspaceId) return undefined;
  return session.gitWorktrees?.[session.workspaceId]?.path ?? workspaces.find((w) => w.id === session.workspaceId)?.path;
}

/** Chats whose index entry is missing or older than the summary. */
export function staleChats(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter((s) => !s.incognito && index.get(s.id)?.updatedAt !== s.updatedAt);
}

export const chatIndex = (): ReadonlyMap<string, IndexedChat> => index;

export interface IndexProgress { done: number; total: number }

/**
 * Bring the index up to date with `sessions`, newest chats first, reporting
 * after each batch. Cached transcripts are used when current. Stops early when
 * `signal` aborts; whatever was read stays indexed. A chat that fails to load
 * is skipped this round (and retried next time).
 */
export async function refreshChatIndex(
  sessions: readonly SessionSummary[],
  workspaces: ReadonlyArray<{ id: string; path: string }>,
  onProgress: (p: IndexProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const live = new Set(sessions.map((s) => s.id));
  for (const id of index.keys()) if (!live.has(id)) index.delete(id);
  const todo = staleChats(sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  const total = todo.length;
  let done = 0;
  onProgress({ done, total });
  const batches: SessionSummary[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  const read = async (batch: SessionSummary[]): Promise<void> => {
    const fresh: SessionSummary[] = [];
    for (const summary of batch) {
      const cached = getCachedSession(summary.id);
      if (cached && cached.updatedAt >= summary.updatedAt && Array.isArray(cached.messages)) index.set(summary.id, indexChat({ ...cached, updatedAt: summary.updatedAt }, basePathOf(cached, workspaces)));
      else fresh.push(summary);
    }
    if (!fresh.length) return;
    const views = await Promise.resolve().then(() => window.nekko.finderChatText(fresh.map((s) => s.id))).catch(() => null);
    await Promise.all(fresh.map(async (summary) => {
      // A daemon without the text channel, or a chat it could not read: the whole transcript instead.
      const view = views?.[summary.id];
      const text = view && Array.isArray(view.messages) ? fromText(view) : views ? null : await window.nekko.getSession(summary.id).catch(() => null);
      if (text && Array.isArray(text.messages)) index.set(summary.id, indexChat({ ...text, updatedAt: summary.updatedAt }, basePathOf(text, workspaces)));
    }));
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, async () => {
    while (next < batches.length) {
      if (signal?.aborted) return;
      const batch = batches[next++];
      await read(batch);
      done = Math.min(total, done + batch.length);
      if (signal?.aborted) return;
      onProgress({ done, total });
    }
  }));
}

/** Tests only. */
export function __resetChatIndex(): void { index.clear(); }

/**
 * The chat finder's transcript index: every user and assistant message's text
 * and every artifact a chat produced, per chat, so the finder can search whole
 * conversations rather than the summary alone.
 *
 * Built in the renderer from transcripts the host already serves (`getSession`),
 * so nothing new is stored on disk. Each chat is read once per version: an
 * entry stays valid while the chat's `updatedAt` is unchanged, and the index
 * survives the popup closing, so a second search is a filter over memory.
 * Only text is kept, never images, videos, reasoning or tool output.
 */
import type { Session, SessionSummary } from '@nekko-agent/shared';
import { getCachedSession } from '../sessionCache.js';
import { sessionArtifacts } from '../artifactsIndex.js';
import type { IndexedChat, IndexedMessage } from './chatFinder.js';

/** Transcripts read at once. Enough to keep IPC busy, few enough not to stall the host. */
const BATCH = 6;

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
  for (let i = 0; i < todo.length; i += BATCH) {
    if (signal?.aborted) return;
    await Promise.all(todo.slice(i, i + BATCH).map(async (summary) => {
      const cached = getCachedSession(summary.id);
      const full = cached && cached.updatedAt >= summary.updatedAt ? cached : await window.nekko.getSession(summary.id).catch(() => null);
      if (full && Array.isArray(full.messages)) index.set(summary.id, indexChat({ ...full, updatedAt: summary.updatedAt }, basePathOf(full, workspaces)));
    }));
    done = Math.min(total, i + BATCH);
    if (signal?.aborted) return;
    onProgress({ done, total });
  }
}

/** Tests only. */
export function __resetChatIndex(): void { index.clear(); }

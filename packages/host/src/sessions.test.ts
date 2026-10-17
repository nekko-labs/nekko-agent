import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@nekko-agent/shared';
import { summarizeSession } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { createSession, deleteSession, getSession, listSessionSummaries, saveSession, setSessionOptions } from './sessions.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-sessions-'));
  setDataDir(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const withTranscript = (s: Session): Session => ({
  ...s,
  title: 'Refactor the parser',
  messages: [
    { id: 'u1', role: 'user', content: 'Review the parser and open a PR', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', input: { command: 'gh pr create' } }], createdAt: 2 },
    { id: 't1', role: 'tool', content: '', toolResult: { toolCallId: 'c1', output: 'https://github.com/o/r/pull/7' }, createdAt: 3 },
    { id: 'a2', role: 'assistant', content: 'Opened   the PR.\nAll green.', createdAt: 4 },
  ],
});

describe('listSessionSummaries', () => {
  it('lists every chat without its transcript, with what lists read off it', async () => {
    const s = withTranscript(createSession());
    saveSession(s);
    const [summary] = await listSessionSummaries();
    expect(summary).not.toHaveProperty('messages');
    expect(summary).toMatchObject({
      id: s.id,
      title: 'Refactor the parser',
      messageCount: 4,
      exchangeCount: 3,
      firstUserText: 'Review the parser and open a PR',
      lastReplyText: 'Opened the PR. All green.',
      lastReplyAt: 4,
      stalled: false,
      prUrls: ['https://github.com/o/r/pull/7'],
    });
    expect(summary.recentTurns.map((t) => t.id)).toEqual(['u1', 'a2']);
    expect(summary).toEqual(summarizeSession(getSession(s.id)!));
  });

  it('sorts newest first and drops deleted chats', async () => {
    const a = createSession();
    const b = createSession();
    b.updatedAt = a.updatedAt + 1_000;
    writeFileSync(join(dir, 'sessions', `${b.id}.json`), JSON.stringify(b));
    expect((await listSessionSummaries()).map((s) => s.id)).toEqual([b.id, a.id]);
    deleteSession(b.id);
    expect((await listSessionSummaries()).map((s) => s.id)).toEqual([a.id]);
  });

  it('re-reads a chat another process rewrote, and serves the rest from cache', async () => {
    const s = createSession();
    await listSessionSummaries();
    const file = join(dir, 'sessions', `${s.id}.json`);
    writeFileSync(file, JSON.stringify({ ...withTranscript(s), title: 'Changed elsewhere' }));
    // Same second as the first write on coarse filesystems: move the mtime on.
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const [summary] = await listSessionSummaries();
    expect(summary.title).toBe('Changed elsewhere');
    expect(summary.messageCount).toBe(4);
  });

  it('skips a file that is not a session', async () => {
    createSession();
    writeFileSync(join(dir, 'sessions', 'broken.json'), '{ not json');
    expect(await listSessionSummaries()).toHaveLength(1);
  });
});

describe('setSessionOptions', () => {
  it('cannot bypass sandbox through the legacy isolation flag or injected setup', () => {
    const s = createSession();
    s.executionMode = 'sandbox'; saveSession(s);
    expect(setSessionOptions(s.id, { gitIsolation: false })?.executionMode).toBe('sandbox');
    expect(setSessionOptions(s.id, { gitIsolation: true })?.gitIsolation).toBe(false);
    expect(() => setSessionOptions(s.id, { sandbox: {} } as any)).toThrow('setup route');
  });
  it('persists the configured new-chat execution default', async () => {
    const { saveSettings } = await import('./store.js');
    saveSettings({ defaultExecutionMode: 'sandbox' });
    const s = createSession();
    expect(getSession(s.id)?.executionMode).toBe('sandbox');
    saveSettings({ defaultExecutionMode: 'worktree' });
  });
  it('persists per-session git isolation without dropping saved worktrees', () => {
    const s = createSession('w1');
    s.gitWorktrees = { w1: { sourceRoot: '/repo', root: '/wt', path: '/wt', branch: 'nekko/test', notice: 'notice' } };
    saveSession(s);
    const saved = setSessionOptions(s.id, { gitIsolation: false });
    expect(saved?.gitIsolation).toBe(false);
    expect(saved?.gitWorktrees?.w1.path).toBe('/wt');
  });
});

describe('saveTurnSession', () => {
  it('keeps what the user changed mid-turn and what the turn produced', async () => {
    const { saveTurnSession, setSessionOptions, queuePrompt } = await import('./sessions.js');
    const s = createSession('w1');
    // The turn reads the chat at its start and works on its own copy.
    const turn = getSession(s.id)!;
    turn.title = 'Placeholder from the prompt';
    turn.titleAuto = true;
    turn.messages.push({ id: 'u1', role: 'user', content: 'hi', createdAt: 1 }, { id: 'a1', role: 'assistant', content: 'hello', createdAt: 2 });
    turn.modelId = 'the-model-it-ran';
    // Meanwhile the user renames, pins, and queues through another writer.
    setSessionOptions(s.id, { title: 'Mine', pinned: true, thinking: true });
    queuePrompt(s.id, 'next');
    saveTurnSession(turn);
    const saved = getSession(s.id)!;
    expect(saved.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(saved.modelId).toBe('the-model-it-ran');
    expect(saved).toMatchObject({ title: 'Mine', titleAuto: false, pinned: true, thinking: true, queue: ['next'], workspaceId: 'w1' });
  });

  it('lets an automatic title through when the user has not named the chat', async () => {
    const { saveTurnSession } = await import('./sessions.js');
    const s = createSession();
    const turn = getSession(s.id)!;
    turn.title = 'From the prompt';
    turn.titleAuto = true;
    saveTurnSession(turn);
    expect(getSession(s.id)!.title).toBe('From the prompt');
  });
});

// New windows use app preferences, not privacy flags from the current chat.
import { saveSettings, getSettings } from './store.js';
describe('new session defaults', () => {
  it('uses saved execution defaults and never inherits incognito or offline', () => {
    saveSettings({ defaultProviderId: 'saved', defaultModelId: 'exact', defaultChatMode: 'ask', effort: 'high', defaultExecutionMode: 'unified', gitManagement: { mode: 'shared' } });
    const existing = createSession();
    setSessionOptions(existing.id, { incognito: true, offline: true, mode: 'yolo' });
    const next = createSession();
    expect(next).toMatchObject({ executionMode: 'unified', gitIsolation: false });
    expect(next.incognito).toBeUndefined();
    expect(next.offline).toBeUndefined();
    // Model, mode and effort remain effective app defaults until explicitly set.
    expect(next.providerId ?? getSettings().defaultProviderId).toBe('saved');
    expect(next.modelId ?? getSettings().defaultModelId).toBe('exact');
    expect(next.mode ?? getSettings().defaultChatMode).toBe('ask');
    expect(getSettings().effort).toBe('high');
  });
});

describe('default saved mode', () => {
  it('starts a new top-level chat in it, and leaves sub-agents and unset defaults alone', async () => {
    const { saveSettings } = await import('./store.js');
    expect(createSession()).not.toHaveProperty('incognito');
    saveSettings({ defaultSavedModeId: 'private' });
    const chat = createSession();
    expect(chat).toMatchObject({ incognito: true, mode: 'ask', executionMode: 'worktree', gitIsolation: true, workMode: 'default', disabledTools: [] });
    expect(getSession(chat.id)).toMatchObject({ incognito: true });
    expect(createSession(undefined, chat.id)).not.toHaveProperty('incognito');
    saveSettings({ defaultSavedModeId: 'untrusted-repo' });
    expect(createSession()).toMatchObject({ executionMode: 'sandbox', mode: 'ask' });
  });
});

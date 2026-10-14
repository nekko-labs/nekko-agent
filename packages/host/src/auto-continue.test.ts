import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Session } from '@nekko-agent/shared';
import { CONTINUE_AFTER_COMPACTION, MAX_AUTO_CONTINUES, startAutoContinue, type AutoContinueDeps } from './auto-continue.js';

const OVERFLOW = 'Model request failed (HTTP 400): the request exceeds the available context size, try increasing it';

function chat(over: Partial<Session> = {}): Session {
  return { id: 's1', title: 't', providerId: 'p', modelId: 'm', messages: [{ id: 'u', role: 'user', content: 'go', createdAt: 1 }], createdAt: 1, updatedAt: 1, ...over } as Session;
}

function rig(session: Session | null = chat(), window = 8_000) {
  let listener: (e: AgentEvent) => void = () => {};
  let running = false;
  const calls: string[] = [];
  const notices: AgentEvent[] = [];
  const deps: AutoContinueDeps = {
    onEvent: (fn) => { listener = fn; return () => {}; },
    getSession: () => session,
    isRunning: () => running,
    contextWindow: () => window,
    compact: vi.fn(async (id: string) => { calls.push(`compact:${id}`); }),
    send: vi.fn(async (s: Session, text: string) => { calls.push(`send:${s.id}:${text === CONTINUE_AFTER_COMPACTION ? 'continue' : text}`); }),
    notify: (e) => notices.push(e),
    sleep: async () => { running = false; },
  };
  startAutoContinue(deps);
  const emit = async (e: AgentEvent) => { listener(e); for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { deps, calls, notices, emit, setRunning: (r: boolean) => { running = r; } };
}

describe('auto-continue after a context overflow', () => {
  it('compacts the chat and sends it on', async () => {
    const r = rig();
    await r.emit({ type: 'error', sessionId: 's1', message: OVERFLOW });
    expect(r.calls).toEqual(['compact:s1', 'send:s1:continue']);
  });

  it('waits for the ending turn to let go of the chat first', async () => {
    const r = rig();
    r.setRunning(true);
    await r.emit({ type: 'error', sessionId: 's1', message: OVERFLOW });
    expect(r.calls).toEqual(['compact:s1', 'send:s1:continue']);
  });

  it('leaves other failures, and chats it must not touch, alone', async () => {
    const r = rig();
    await r.emit({ type: 'error', sessionId: 's1', message: 'anthropic 401: invalid x-api-key' });
    await r.emit({ type: 'error', sessionId: 's1', message: '429 rate limit: too many tokens per min' });
    expect(r.calls).toEqual([]);
    for (const over of [{ incognito: true }, { parentSessionId: 'parent' }, { trainingRunId: 'run' }, { archivedAt: 5 }, { queue: ['next'] }]) {
      const other = rig(chat(over));
      await other.emit({ type: 'error', sessionId: 's1', message: OVERFLOW });
      expect(other.calls).toEqual([]);
    }
  });

  it('stops after a bounded number of tries until a reply finishes', async () => {
    const r = rig();
    for (let i = 0; i <= MAX_AUTO_CONTINUES; i++) await r.emit({ type: 'error', sessionId: 's1', message: OVERFLOW });
    expect(r.calls.filter((c) => c.startsWith('send'))).toHaveLength(MAX_AUTO_CONTINUES);
    expect(r.notices.at(-1)).toMatchObject({ type: 'error', sessionId: 's1' });
    await r.emit({ type: 'done', sessionId: 's1', messageId: 'm' });
    await r.emit({ type: 'error', sessionId: 's1', message: OVERFLOW });
    expect(r.calls.filter((c) => c.startsWith('send'))).toHaveLength(MAX_AUTO_CONTINUES + 1);
  });

  it('reports a compaction that fails instead of sending', async () => {
    const r = rig();
    r.deps.compact = vi.fn(async () => { throw new Error('Offline conversations can only be compacted locally.'); });
    await r.emit({ type: 'error', sessionId: 's1', message: OVERFLOW });
    expect(r.calls).toEqual([]);
    expect(r.notices[0]).toMatchObject({ type: 'error', message: expect.stringContaining('could not be compacted') });
  });
});

describe('compaction after a finished reply', () => {
  it('compacts a chat whose transcript is near the window', async () => {
    const big = chat({ messages: [{ id: 'u', role: 'user', content: 'x'.repeat(4 * 7_000), createdAt: 1 }] });
    const r = rig(big, 8_000);
    await r.emit({ type: 'done', sessionId: 's1', messageId: 'm' });
    expect(r.calls).toEqual(['compact:s1']);
  });

  it('leaves a chat with room to spare alone', async () => {
    const r = rig(chat(), 8_000);
    await r.emit({ type: 'done', sessionId: 's1', messageId: 'm' });
    expect(r.calls).toEqual([]);
  });
});

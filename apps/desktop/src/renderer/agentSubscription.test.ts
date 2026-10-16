import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAgentSubscription, claimAgentEvents, startAgentSubscription, subscribedSessions } from './agentSubscription.js';

const flush = () => new Promise<void>((r) => queueMicrotask(r));

type Row = { id: string; parentSessionId?: string };
function sessionList(initial: Row[] = []) {
  let rows = initial;
  const watchers = new Set<() => void>();
  return {
    source: { list: () => rows, watch: (fn: () => void) => { watchers.add(fn); return () => watchers.delete(fn); } },
    set(next: Row[]) { rows = next; watchers.forEach((fn) => fn()); },
  };
}

describe('which chats a window takes the stream of (#551)', () => {
  const sent: Array<string[] | null> = [];
  beforeEach(() => {
    __resetAgentSubscription();
    sent.length = 0;
    vi.stubGlobal('window', { nekko: { subscribeAgentEvents: (ids: string[] | null) => sent.push(ids) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('takes the shown chats and their sub-agents, counting each claim', async () => {
    const list = sessionList([{ id: 'p' }, { id: 'c1', parentSessionId: 'p' }, { id: 'g', parentSessionId: 'c1' }, { id: 'other' }]);
    const stop = startAgentSubscription(list.source);
    await flush();
    expect(sent.at(-1)).toEqual([]);
    const a = claimAgentEvents('p');
    const b = claimAgentEvents('p');
    await flush();
    expect(sent.at(-1)).toEqual(['c1', 'g', 'p']);
    a();
    a(); // a release only counts once
    await flush();
    expect(subscribedSessions()).toEqual(['c1', 'g', 'p']);
    b();
    await flush();
    expect(sent.at(-1)).toEqual([]);
    stop();
    expect(sent.at(-1)).toBeNull();
  });

  it('tells the engine once per change, and again when a sub-agent appears', async () => {
    const list = sessionList([{ id: 'p' }]);
    const stop = startAgentSubscription(list.source);
    claimAgentEvents('p');
    claimAgentEvents('q');
    await flush();
    const n = sent.length;
    list.set([{ id: 'p' }, { id: 'kid', parentSessionId: 'p' }]);
    await flush();
    expect(sent.length).toBe(n + 1);
    expect(sent.at(-1)).toEqual(['kid', 'p', 'q']);
    list.set([{ id: 'p' }, { id: 'kid', parentSessionId: 'p' }]);
    await flush();
    expect(sent.length).toBe(n + 1);
    stop();
  });

  it('does nothing where the engine cannot narrow', () => {
    vi.stubGlobal('window', { nekko: {} });
    const stop = startAgentSubscription(sessionList().source);
    claimAgentEvents('p')();
    stop();
    expect(sent).toEqual([]);
  });
});

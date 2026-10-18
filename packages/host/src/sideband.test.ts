import { beforeEach, describe, expect, it, vi } from 'vitest';

const daemon = vi.fn();
let linked = true;
vi.mock('./engine/daemon.js', () => ({ daemonCall: () => (linked ? daemon : undefined) }));
// Probe per fixture: the real daemonOwns caches capabilities for the process lifetime.
vi.mock('./daemon-caps.js', () => ({
  daemonOwns: async (call: typeof daemon, channel: string) => (await call('daemon:info')).owned.includes(channel),
}));
let promptCaching: boolean | undefined = true;
vi.mock('./store.js', () => ({ getSettings: () => ({ promptCaching }) }));
const recordUsage = vi.fn();
vi.mock('./usage.js', () => ({ recordUsage }));
const chat = vi.fn();
vi.mock('@nekko-agent/core', () => ({ createProvider: () => ({ chat }) }));

const { completeText } = await import('./sideband.js');

const provider = { id: 'p', kind: 'llamacpp', label: 'P', baseUrl: 'http://x', enabled: true } as never;
const request = { model: 'm', messages: [], purpose: 'title' as const };

describe('completeText', () => {
  beforeEach(() => {
    daemon.mockReset();
    chat.mockReset();
    recordUsage.mockReset();
    linked = true;
    promptCaching = true;
  });

  it('asks the daemon when it serves provider:complete', async () => {
    daemon.mockImplementation(async (channel: string) =>
      channel === 'daemon:info' ? { owned: ['provider:complete', 'provider:prompt-caching'] } : { text: 'Fix the parser' },
    );
    expect(await completeText(provider, request, 5_000)).toBe('Fix the parser');
    expect(daemon).toHaveBeenLastCalledWith('provider:complete', { provider, request: { ...request, promptCaching: true }, timeoutMs: 5_000, usageOnFailure: true });
    expect(chat).not.toHaveBeenCalled();
  });

  it.each(['title', 'suggest', 'fill'] as const)('records successful daemon %s usage once, including zero counters', async (purpose) => {
    const usage = [
      { type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 20 },
      { type: 'usage', inputTokens: 0, outputTokens: 0 },
    ];
    daemon.mockImplementation(async (channel: string) =>
      channel === 'daemon:info' ? { owned: ['provider:complete', 'provider:prompt-caching'] } : { text: 'result', usage },
    );
    expect(await completeText(provider, { ...request, purpose }, 5_000, 's')).toBe('result');
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      providerId: 'p', modelId: 'm', sessionId: 's', local: true,
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 20,
    });
    expect(recordUsage.mock.calls[1][0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(chat).not.toHaveBeenCalled();
  });

  it('records local usage only once on success, preserving subscription metadata', async () => {
    linked = false;
    chat.mockImplementation(async function* () {
      yield { type: 'usage', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
      yield { type: 'text', delta: 'result' };
      yield { type: 'done' };
      throw new Error('must stop at done');
    });
    await completeText({ id: 'sub', kind: 'chatgpt', label: 'Sub', enabled: true, auth: 'subscription' }, request, 5_000, 's');
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0][0]).toMatchObject({ providerId: 'sub', auth: 'subscription', local: false, sessionId: 's', cacheReadTokens: 3, cacheWriteTokens: 4 });
  });

  it.each(['error', 'timeout'] as const)('persists observed local usage once on %s', async (failure) => {
    linked = false;
    chat.mockImplementation(async function* ({ signal }) {
      yield { type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 20 };
      yield { type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      yield { type: 'text', delta: 'partial' };
      if (failure === 'error') throw new Error('network failed');
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    await expect(completeText(provider, request, 10, 's')).rejects.toThrow(failure === 'error' ? 'network failed' : 'too long');
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage.mock.calls[0][0]).toMatchObject({ sessionId: 's', inputTokens: 0, outputTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 20 });
    expect(recordUsage.mock.calls[1][0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it.each(['network failed', 'The model took too long to answer.'])('persists daemon usage before throwing %s without retrying', async (error) => {
    daemon.mockImplementation(async (channel: string) =>
      channel === 'daemon:info' ? { owned: ['provider:complete', 'provider:prompt-caching'] } : {
        text: '', error, usage: [
          { type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 20 },
          { type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ],
      },
    );
    await expect(completeText(provider, request, 5_000, 's')).rejects.toThrow(error);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage.mock.calls[0][0]).toMatchObject({ sessionId: 's', inputTokens: 0, outputTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 20 });
    expect(recordUsage.mock.calls[1][0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(daemon.mock.calls.filter(([channel]) => channel === 'provider:complete')).toHaveLength(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it('does not retry or invent accounting when the daemon fails', async () => {
    daemon.mockImplementation(async (channel: string) => {
      if (channel === 'daemon:info') return { owned: ['provider:complete', 'provider:prompt-caching'] };
      throw new Error('The model took too long to answer.');
    });
    await expect(completeText(provider, request)).rejects.toThrow('too long');
    expect(recordUsage).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it.each([undefined, true, false])('falls back and records cache usage when an older daemon lacks caching support (%s)', async (setting) => {
    promptCaching = setting;
    daemon.mockImplementation(async () => ({ owned: ['provider:complete'] }));
    chat.mockImplementation(async function* () {
      yield { type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 20 };
      yield { type: 'text', delta: 'title' };
    });
    expect(await completeText(provider, request)).toBe('title');
    expect(chat.mock.calls[0][0].promptCaching).toBe(setting !== false);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0][0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 20 });
    expect(daemon.mock.calls.some(([channel]) => channel === 'provider:complete')).toBe(false);
  });

  it('runs here without a daemon, or with the kill switch on', async () => {
    chat.mockImplementation(async function* () {
      yield { type: 'reasoning', delta: 'hmm' };
      yield { type: 'text', delta: 'Fix ' };
      yield { type: 'text', delta: 'it' };
    });
    linked = false;
    expect(await completeText(provider, request)).toBe('Fix it');
    expect(daemon).not.toHaveBeenCalled();
    expect(chat.mock.calls[0][0]).toMatchObject({ model: 'm', purpose: 'title', signal: expect.any(AbortSignal) });
  });
});

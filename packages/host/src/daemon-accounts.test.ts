import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@nekko-agent/shared';
import type { Provider } from '@nekko-agent/core';

/**
 * The host as a client of a daemon that keeps the usage and reply logs and
 * the limit state (crates/nekkod/src/accounts.rs): limits calls go to the
 * daemon, a daemon-driven turn's accounting is left to it, and the relay
 * still hears limit changes. The daemon is a fake; crates/nekkod/tests
 * daemon.rs plays the real one.
 */

const daemonCall = vi.hoisted(() => vi.fn<() => unknown>(() => undefined));
vi.mock('./engine/daemon.js', async () => ({ ...(await vi.importActual<typeof import('./engine/daemon.js')>('./engine/daemon.js')), daemonCall }));
const syncMcp = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./mcp.js', () => ({ syncMcp, mcpToolSpecs: () => [], isMcpTool: () => false, callMcpTool: vi.fn(), DAEMON_MCP: 'turn:mcp' }));
vi.mock('@nekko-agent/core', async () => {
  const actual = await vi.importActual<typeof import('@nekko-agent/core')>('@nekko-agent/core');
  return {
    ...actual,
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat() { yield { type: 'done' as const }; },
    }),
  };
});

const { setDataDir } = await import('./paths.js');
const { saveSettings } = await import('./store.js');
const { createSession, saveSession } = await import('./sessions.js');
const { sendChat } = await import('./chat.js');
const { turnCallback } = await import('./daemon-turn.js');
const Limits = await import('./limits.js');

const calls: Array<[string, unknown[]]> = [];
const answers: Record<string, unknown> = {};

function useFakeDaemon(): void {
  daemonCall.mockReturnValue(async (channel: string, ...args: unknown[]) => {
    calls.push([channel, args]);
    if (channel === 'daemon:info') return { owned: ['chat:turn', 'turn:alive', 'turn:account', 'turn:mcp', 'limits:get', 'limits:poll'] };
    if (channel === 'chat:turn') {
      const spec = args[0] as { turnId: string; opts: { sessionId: string } };
      setTimeout(() => void (async () => {
        const e = (x: Record<string, unknown>) => ({ sessionId: spec.opts.sessionId, ...x });
        await turnCallback('turn:event', [spec.turnId, { events: [e({ type: 'usage', inputTokens: 5, outputTokens: 2 })] }]);
        await turnCallback('turn:event', [spec.turnId, { events: [e({ type: 'done', stop: 'complete', steps: 0 })], stats: { inputTokens: 5 }, startedAt: 1 }]);
        await turnCallback('turn:end', [spec.turnId, { stop: 'complete', aborted: false }]);
      })(), 0);
      return { started: true };
    }
    return answers[channel] ?? null;
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-daccounts-'));
  setDataDir(dir);
  calls.length = 0;
  daemonCall.mockReturnValue(undefined);
  Limits.initLimits(new EventEmitter());
});

describe('limits with a daemon that owns them', () => {
  it('reads, polls and clears through the daemon and keeps nothing here', async () => {
    useFakeDaemon();
    const snapshot = { windows: [], updatedAt: Date.now(), staleAfterMs: 60_000 };
    answers['limits:get'] = snapshot;
    answers['limits:poll'] = snapshot;
    expect(Limits.get('chatgpt:a')).toBeUndefined();
    expect(await Limits.readLimits('chatgpt:a', true)).toEqual(snapshot);
    expect(await Limits.poll('chatgpt:a')).toEqual(snapshot);
    Limits.clearLimits('chatgpt:a');
    await vi.waitFor(() => expect(calls.some(([c, a]) => c === 'limits:clear' && a[0] === 'chatgpt:a')).toBe(true));
    expect(calls.map(([c]) => c)).toEqual(expect.arrayContaining(['limits:get', 'limits:poll']));
  });

  it('relays a daemon limit change to the phone, marked as already shown', () => {
    const bus = new EventEmitter();
    const seen: unknown[] = [];
    bus.on('limitsUpdated', (e) => seen.push(e));
    Limits.initLimits(bus);
    const limits = { windows: [], updatedAt: 1, staleAfterMs: 1 };
    Limits.notifyFromDaemon({ tokenKey: 'claude:a', limits });
    expect(seen).toEqual([{ tokenKey: 'claude:a', limits, relayOnly: true }]);
  });

  it('leaves a daemon-driven turn\'s usage and reply lines to the daemon', async () => {
    useFakeDaemon();
    const ws = mkdtempSync(join(tmpdir(), 'nekko-daccounts-ws-'));
    saveSettings({
      workspaces: [{ id: 'w1', name: 'ws', path: ws, addedAt: 0 }],
      providers: [{ id: 'p1', kind: 'llamacpp', label: 'Local', baseUrl: 'http://127.0.0.1:9/v1', enabled: true }],
      defaultChatMode: 'yolo',
      mcpServers: [{ id: 'srv', name: 'srv', enabled: true, command: 'x', args: [] }],
    });
    const s = createSession('w1');
    s.title = 'Named';
    s.titleAuto = false;
    s.gitIsolation = false;
    saveSession(s);
    await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'hi' }, () => {});
    const spec = calls.find(([c]) => c === 'chat:turn')![1][0] as { facts: Record<string, unknown> };
    expect(spec.facts.account).toEqual({ kind: 'llamacpp', incognito: false });
    // The daemon runs this turn's MCP servers: it gets the list; this host only
    // refreshes its own snapshot in the background.
    expect(spec.facts.mcpServers).toEqual([{ id: 'srv', name: 'srv', enabled: true, command: 'x', args: [] }]);
    expect(spec.facts).not.toHaveProperty('mcpTools');
    expect(syncMcp).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, 'usage.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'replies.jsonl'))).toBe(false);
    // The relay and messaging are still this host's here: it reads every event.
    expect(spec.facts).not.toHaveProperty('hostEvents');
  });

  it('asks only how the turn ends when the relay and messaging are the daemon\'s too (#551)', async () => {
    useFakeDaemon();
    const before = process.env.NEKKOD_OWNS;
    process.env.NEKKOD_OWNS = 'settings,remote,messaging';
    try {
      const ws = mkdtempSync(join(tmpdir(), 'nekko-daccounts-ws-'));
      saveSettings({
        workspaces: [{ id: 'w1', name: 'ws', path: ws, addedAt: 0 }],
        providers: [{ id: 'p1', kind: 'llamacpp', label: 'Local', baseUrl: 'http://127.0.0.1:9/v1', enabled: true }],
        defaultChatMode: 'yolo',
      });
      const s = createSession('w1');
      s.title = 'Named';
      s.titleAuto = false;
      s.gitIsolation = false;
      saveSession(s);
      await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'hi' }, () => {});
      const spec = calls.find(([c]) => c === 'chat:turn')![1][0] as { facts: Record<string, unknown> };
      expect(spec.facts.hostEvents).toEqual(['done', 'error']);
    } finally {
      if (before === undefined) delete process.env.NEKKOD_OWNS;
      else process.env.NEKKOD_OWNS = before;
    }
  });
});

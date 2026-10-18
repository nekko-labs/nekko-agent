import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ProviderConfig } from '@nekko-agent/shared';
import type { Provider, ProviderChunk } from '@nekko-agent/core';

/**
 * The host's half of a daemon-driven chat turn (daemon-turn.ts, chat.ts):
 * what it puts in the `chat:turn` spec, how it relays the daemon's events,
 * runs the tools that still live here, bridges their approvals to the
 * daemon, forwards pending input, steering and Stop, and what it does after
 * the turn. The daemon is a fake that plays its side through `turnCallback`
 * (crates/nekkod/tests/daemon.rs plays the real one against a fake host).
 */

const daemonCall = vi.hoisted(() => vi.fn<() => unknown>(() => undefined));
vi.mock('./engine/daemon.js', async () => ({ ...(await vi.importActual<typeof import('./engine/daemon.js')>('./engine/daemon.js')), daemonCall }));
const mcpToolSpecs = vi.hoisted(() => vi.fn(() => [{ name: 'mcp__srv__echo', description: 'Echo', parameters: { type: 'object', properties: {} } }]));
const callMcpTool = vi.hoisted(() => vi.fn(async (call: { id: string }) => ({ toolCallId: call.id, output: 'mcp says hi' })));
vi.mock('./mcp.js', () => ({ syncMcp: vi.fn(async () => {}), mcpToolSpecs, isMcpTool: (n: string) => n.startsWith('mcp__'), callMcpTool, DAEMON_MCP: 'turn:mcp' }));

let rounds: ProviderChunk[][] = [];
vi.mock('@nekko-agent/core', async () => {
  const actual = await vi.importActual<typeof import('@nekko-agent/core')>('@nekko-agent/core');
  return {
    ...actual,
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat() {
        for (const c of rounds.shift() ?? [{ type: 'done' as const }]) yield c;
      },
    }),
  };
});

const { setDataDir } = await import('./paths.js');
const { saveSettings } = await import('./store.js');
const { createSession, getSession, saveSession } = await import('./sessions.js');
const { sendChat, getPendingInput, resolveApproval, answerQuestion, steerChat, abortChat, isChatRunning } = await import('./chat.js');
const { turnCallback, mergePending } = await import('./daemon-turn.js');

type Spec = { turnId: string; opts: { sessionId: string; text: string }; queued?: unknown; settings: Record<string, unknown>; facts: Record<string, unknown> };

/** A fake daemon: records calls, and runs `script` for each `chat:turn`. */
function fakeDaemon(script: (spec: Spec, calls: Array<[string, unknown[]]>) => Promise<void>, extra: Record<string, (args: unknown[]) => unknown> = {}) {
  // Not `loop:run`: a turn the daemon refuses then runs entirely in process.
  const calls: Array<[string, unknown[]]> = [];
  const call = vi.fn(async (channel: string, ...args: unknown[]) => {
    calls.push([channel, args]);
    if (channel === 'daemon:info') return { owned: ['chat:turn', 'turn:alive'] };
    if (channel in extra) return extra[channel](args);
    if (channel === 'chat:turn') {
      // Like the daemon: return at once, drive the turn after.
      setTimeout(() => void script(args[0] as Spec, calls), 0);
      return { started: true };
    }
    if (channel === 'turn:pending') return {};
    return true;
  });
  daemonCall.mockReturnValue(call);
  return { call, calls };
}

const event = (spec: Spec, e: Record<string, unknown>) => ({ sessionId: spec.opts.sessionId, ...e });

let dir: string;
let workspace: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-dturn-'));
  workspace = mkdtempSync(join(tmpdir(), 'nekko-dturn-ws-'));
  setDataDir(dir);
  saveSettings({
    workspaces: [{ id: 'w1', name: 'ws', path: workspace, addedAt: 0 }],
    providers: [{ id: 'p1', kind: 'openai-compat', label: 'Local', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', enabled: true }],
    defaultChatMode: 'ask',
    systemInstructions: 'Be brief.',
    mcpServers: [{ id: 'srv', name: 'srv', enabled: true, transport: 'stdio', command: 'x' } as never],
  });
  rounds = [];
  daemonCall.mockReturnValue(undefined);
  vi.clearAllMocks();
});

function named(): ReturnType<typeof createSession> {
  const s = createSession('w1');
  s.title = 'Named';
  s.titleAuto = false;
  s.gitIsolation = false;
  saveSession(s);
  return s;
}

describe('a daemon-driven turn', () => {
  it('hands the daemon a complete spec, relays its events and accounts for them', async () => {
    const s = named();
    let seenSpec: Spec | undefined;
    fakeDaemon(async (spec) => {
      seenSpec = spec;
      await turnCallback('turn:event', [spec.turnId, { events: [event(spec, { type: 'text', delta: 'hel' }), event(spec, { type: 'text', delta: 'lo' })] }]);
      await turnCallback('turn:event', [spec.turnId, { events: [event(spec, { type: 'usage', inputTokens: 5, outputTokens: 2 })] }]);
      await turnCallback('turn:event', [spec.turnId, {
        events: [event(spec, { type: 'done', messageId: 'm1', stop: 'complete', steps: 0 })],
        stats: { providerId: 'p1', modelId: 'm', inputTokens: 5, outputTokens: 2, wallMs: 12, calls: 1 },
        startedAt: 1000,
      }]);
      await turnCallback('turn:end', [spec.turnId, { stop: 'complete', aborted: false }]);
    });
    const events: AgentEvent[] = [];
    await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'hi' }, (e) => events.push(e));

    expect(seenSpec).toBeDefined();
    expect(seenSpec!.opts).toMatchObject({ sessionId: s.id, text: 'hi' });
    expect(seenSpec!.settings).toMatchObject({ systemInstructions: 'Be brief.', defaultChatMode: 'ask' });
    expect(seenSpec!.facts).toMatchObject({
      workspaces: [{ id: 'w1', name: 'ws', path: workspace }],
      mcpTools: [{ name: 'mcp__srv__echo' }],
      decide: false,
      hooks: false,
      platform: process.platform,
      provider: { id: 'p1', kind: 'openai-compat' },
      headers: false,
    });
    // Every event is the caller's too, marked as already shown by the daemon.
    expect(events.map((e) => e.type)).toEqual(['text', 'text', 'usage', 'done']);
    expect(events.every((e) => (e as { relayOnly?: boolean }).relayOnly === true)).toBe(true);
    // The reply log has the daemon's stats; the transcript is the daemon's to write.
    const log = join(dir, 'replies.jsonl');
    expect(existsSync(log)).toBe(true);
    expect(JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()!)).toMatchObject({ sessionId: s.id, startedAt: 1000, inputTokens: 5, wallMs: 12 });
    expect(isChatRunning(s.id)).toBe(false);
  });

  it('runs the tools that still live here, approving through the daemon', async () => {
    const s = named();
    let result: unknown;
    let approvalAsked: unknown[] | undefined;
    fakeDaemon(async (spec) => {
      // MCP needs approval in ask mode: the prompt is parked in the daemon.
      const pending = turnCallback('turn:tool', [spec.turnId, { id: 'c1', name: 'mcp__srv__echo', input: {} }]);
      await vi.waitFor(() => expect(approvalAsked).toBeDefined());
      await turnCallback('turn:approved', ['c1', true]);
      result = await pending;
      await turnCallback('turn:end', [spec.turnId, { aborted: false }]);
    }, {
      'turn:approval': (args) => { approvalAsked = args; return true; },
    });
    await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'echo' }, () => {});
    expect(approvalAsked).toEqual([expect.stringMatching(/^turn_/), { id: 'c1', name: 'mcp__srv__echo', input: {} }, 'Call mcp__srv__echo', 'medium']);
    expect(result).toEqual({ result: { toolCallId: 'c1', output: 'mcp says hi' } });
    expect(callMcpTool).toHaveBeenCalledTimes(1);
  });

  it('refuses a host tool whose approval the daemon declines', async () => {
    const s = named();
    let result: unknown;
    fakeDaemon(async (spec) => {
      const pending = turnCallback('turn:tool', [spec.turnId, { id: 'c2', name: 'mcp__srv__echo', input: {} }]);
      await new Promise((r) => setTimeout(r, 5));
      await turnCallback('turn:approved', ['c2', false]);
      result = await pending;
      await turnCallback('turn:end', [spec.turnId, { aborted: false }]);
    });
    await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'echo' }, () => {});
    expect(result).toEqual({ result: { toolCallId: 'c2', output: 'Call not approved by user.', isError: true } });
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('forwards steering, Stop, approvals and answers to the daemon while it drives the turn', async () => {
    const s = named();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { calls } = fakeDaemon(async (spec) => {
      await held;
      await turnCallback('turn:end', [spec.turnId, { aborted: true }]);
    }, {
      'turn:steer': () => true,
      'turn:approve': () => true,
      'turn:answer': () => true,
      'turn:pending': () => ({ [s.id]: { sessionId: s.id, question: { callId: 'q9', questions: [], askedAt: 1 } } }),
      'turn:abort': () => { release(); return true; },
    });
    const run = sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'long' }, () => {});
    await vi.waitFor(() => expect(calls.some(([c]) => c === 'chat:turn')).toBe(true));
    await new Promise((r) => setTimeout(r, 5));

    expect(isChatRunning(s.id)).toBe(true);
    await steerChat(s.id, '  also do this  ');
    const steer = calls.find(([c]) => c === 'turn:steer')!;
    expect(steer[1][0]).toBe(s.id);
    expect(steer[1][1]).toMatchObject({ role: 'user', content: 'also do this' });

    expect((await getPendingInput())[s.id]?.question?.callId).toBe('q9');
    await resolveApproval(s.id, 'c_daemon', true);
    expect(calls).toContainEqual(['turn:approve', [s.id, 'c_daemon', true]]);
    await answerQuestion(s.id, 'q9', []);
    expect(calls).toContainEqual(['turn:answer', [s.id, 'q9', []]]);

    abortChat(s.id);
    await run;
    expect(calls.some(([c]) => c === 'turn:abort')).toBe(true);
    expect(isChatRunning(s.id)).toBe(false);
  });

  it('admits the queued prompt the daemon goes on to, and waits for it as part of the same send', async () => {
    const s = named();
    s.queue = ['next one'];
    saveSession(s);
    const specs: Spec[] = [];
    const events: AgentEvent[] = [];
    const { calls } = fakeDaemon(async (first) => {
      specs.push(first);
      await turnCallback('turn:event', [first.turnId, { events: [event(first, { type: 'done', messageId: 'x', stop: 'complete', steps: 0 })], stats: null, startedAt: 1 }]);
      // Like the daemon after a turn: the host admits the next queued prompt.
      const prepared = await turnCallback('turn:prepare', [first.turnId, { opts: { sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'next one' }, queued: { index: 0, item: 'next one' } }]) as { spec: Spec };
      expect(prepared.spec.turnId).not.toBe(first.turnId);
      specs.push(prepared.spec);
      await turnCallback('turn:end', [first.turnId, { stop: 'complete', aborted: false, next: prepared.spec.turnId }]);
      // The follow-up runs; its events reach the same listener.
      await turnCallback('turn:event', [prepared.spec.turnId, { events: [event(prepared.spec, { type: 'text', delta: 'second' })] }]);
      await turnCallback('turn:end', [prepared.spec.turnId, { stop: 'complete', aborted: false }]);
    });
    await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'first' }, (e) => events.push(e));
    expect(specs.map((x) => x.opts.text)).toEqual(['first', 'next one']);
    expect(specs[1].queued).toEqual({ index: 0, item: 'next one' });
    expect(events.some((e) => e.type === 'text' && (e as { delta: string }).delta === 'second')).toBe(true);
    // The host neither titles nor drains a daemon turn itself: one chat:turn, the follow-up came from turn:prepare.
    expect(calls.filter(([c]) => c === 'chat:turn')).toHaveLength(1);
    expect(isChatRunning(s.id)).toBe(false);
  });

  it('follows a chain the daemon admitted onto the queued turn it admitted too, even when that adoption comes late', async () => {
    const s = named();
    const { adoptAdmittedTurn } = await import('./chat.js');
    fakeDaemon(async () => {});
    const events: AgentEvent[] = [];
    const send = (e: AgentEvent) => events.push(e);
    const base = { workspaces: [], mode: 'ask' as const, decideWith: null, allowBrowserControl: false };
    const opts = { sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'first' };
    await adoptAdmittedTurn({ ...base, turnId: 'turn_d1_a', opts }, send);
    expect(isChatRunning(s.id)).toBe(true);
    // The first turn ends naming its successor before the host has heard of it.
    await turnCallback('turn:end', ['turn_d1_a', { stop: 'complete', aborted: false, next: 'turn_d2_b' }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(isChatRunning(s.id)).toBe(true);
    await adoptAdmittedTurn({ ...base, turnId: 'turn_d2_b', opts: { ...opts, text: 'next one' }, chained: true }, send);
    await turnCallback('turn:event', ['turn_d2_b', { events: [{ sessionId: s.id, type: 'text', delta: 'second' }] }]);
    expect(events.some((e) => e.type === 'text' && (e as { delta: string }).delta === 'second')).toBe(true);
    await turnCallback('turn:end', ['turn_d2_b', { stop: 'complete', aborted: false }]);
    await vi.waitFor(() => expect(isChatRunning(s.id)).toBe(false));
    // A chained adoption with no chain to join is dropped.
    await adoptAdmittedTurn({ ...base, turnId: 'turn_d3_c', opts, chained: true }, send);
    expect(isChatRunning(s.id)).toBe(false);
  });

  it('runs the queued prompt here when the daemon hands it back', async () => {
    const s = named();
    s.queue = ['next one'];
    saveSession(s);
    const specs: Spec[] = [];
    fakeDaemon(async (spec) => {
      specs.push(spec);
      if (spec.queued) {
        const fresh = getSession(s.id)!;
        fresh.queue = [];
        saveSession(fresh);
        await turnCallback('turn:end', [spec.turnId, { stop: 'complete', aborted: false }]);
        return;
      }
      await turnCallback('turn:end', [spec.turnId, { stop: 'complete', aborted: false, drain: 'host' }]);
    });
    await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'first' }, () => {});
    expect(specs.map((x) => x.opts.text)).toEqual(['first', 'next one']);
  });

  it('skips what follows a turn that never started', async () => {
    const s = named();
    s.queue = ['would run'];
    saveSession(s);
    const specs: Spec[] = [];
    fakeDaemon(async (spec) => {
      specs.push(spec);
      await turnCallback('turn:end', [spec.turnId, { early: true }]);
    });
    await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'first' }, () => {});
    expect(specs).toHaveLength(1);
  });

  it('makes a spawn_agent child for the daemon and admits its turns, or says why not', async () => {
    const s = named();
    let made: any;
    let refused: any;
    let resumed: any;
    let parentSpec: Spec | undefined;
    fakeDaemon(async (spec) => {
      if (spec.opts.sessionId !== s.id) return; // the child's own turn: nothing to play
      parentSpec = spec;
      refused = await turnCallback('spawn:prepare', [spec.turnId, { id: 'c0', name: 'spawn_agent', input: { task: '  ' } }, 0]);
      made = await turnCallback('spawn:prepare', [spec.turnId, { id: 'c1', name: 'spawn_agent', input: { task: 'count the files', title: 'Counter' } }, 0]);
      resumed = await turnCallback('spawn:prepare', [spec.turnId, { id: 'c1', name: 'spawn_agent', input: {} }, 1, made.childId]);
      await turnCallback('turn:end', [made.spec.turnId, { stop: 'complete', aborted: false }]);
      await turnCallback('turn:end', [resumed.spec.turnId, { stop: 'complete', aborted: false }]);
      await turnCallback('turn:end', [spec.turnId, { stop: 'complete', aborted: false }]);
    });
    await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'delegate' }, () => {});
    expect(parentSpec!.facts.spawn).toBe(true);
    expect(refused).toEqual({ error: 'A nonblank task is required for the sub-agent.' });
    const child = getSession(made.childId)!;
    expect(child.parentSessionId).toBe(s.id);
    expect(child.title).toBe('Counter');
    expect(made.spec.opts).toMatchObject({ sessionId: made.childId, providerId: 'p1', modelId: 'm', text: 'count the files' });
    expect(made.spec.turnId).not.toBe(parentSpec!.turnId);
    expect(resumed.childId).toBe(made.childId);
    expect(resumed.spec.opts).toMatchObject({ sessionId: made.childId, text: '', resume: true });
  });

  it('runs the turn here when the daemon will not take it', async () => {
    const s = named();
    saveSettings({ defaultChatMode: 'yolo' });
    const { calls } = fakeDaemon(async () => {}, { 'chat:turn': () => { throw new Error('chat:turn needs the daemon to know the data directory'); } });
    rounds = [[{ type: 'text', delta: 'in process' }, { type: 'done' }]];
    await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'hi' }, () => {});
    expect(calls.some(([c]) => c === 'chat:turn')).toBe(true);
    expect(getSession(s.id)!.messages.at(-1)!.content).toBe('in process');
  });

});

describe('after a daemon turn', () => {
  it('logs the title call\'s usage and relays its session_meta', async () => {
    const { setTurnNotifier } = await import('./daemon-turn.js');
    const relayed: AgentEvent[] = [];
    setTurnNotifier((e) => relayed.push(e));
    await turnCallback('turn:usage', [{ provider: { id: 'p1', kind: 'llamacpp' }, modelId: 'm', sessionId: 's_t', usage: [{ type: 'usage', inputTokens: 40, outputTokens: 6 }] }]);
    await turnCallback('turn:notify', [{ type: 'session_meta', sessionId: 's_t' }]);
    const log = readFileSync(join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.at(-1)).toMatchObject({ providerId: 'p1', modelId: 'm', sessionId: 's_t', inputTokens: 40, outputTokens: 6, local: true });
    expect(relayed).toEqual([{ type: 'session_meta', sessionId: 's_t', relayOnly: true }]);
  });
});

describe('what a host asks of a daemon turn\'s events (#551)', () => {
  it('asks only how the turn ends once relay, messaging and accounting are the daemon\'s', async () => {
    const { hostTurnEvents } = await import('./daemon-turn.js');
    const before = process.env.NEKKOD_OWNS;
    try {
      process.env.NEKKOD_OWNS = 'settings,remote,messaging,tasks';
      expect(hostTurnEvents(true)).toEqual(['done', 'error']);
      // Accounting still here, or a TS relay or bridge: every event, as before.
      expect(hostTurnEvents(false)).toBeUndefined();
      process.env.NEKKOD_OWNS = 'settings,messaging';
      expect(hostTurnEvents(true)).toBeUndefined();
      process.env.NEKKOD_OWNS = 'settings,remote';
      expect(hostTurnEvents(true)).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.NEKKOD_OWNS;
      else process.env.NEKKOD_OWNS = before;
    }
  });

  it('leaves it out of the spec while this host accounts the turn itself', async () => {
    // This fake daemon does not own `turn:account` (see daemon-accounts.test.ts
    // for one that does and is asked only for the end).
    const before = process.env.NEKKOD_OWNS;
    let seen: Spec | undefined;
    const s = named();
    fakeDaemon(async (spec) => {
      seen = spec;
      await turnCallback('turn:event', [spec.turnId, { events: [event(spec, { type: 'done', messageId: 'm', stop: 'complete', steps: 0 })], stats: null, startedAt: 1 }]);
      await turnCallback('turn:end', [spec.turnId, { stop: 'complete', aborted: false }]);
    });
    try {
      process.env.NEKKOD_OWNS = 'remote,messaging';
      await sendChat({ sessionId: s.id, providerId: 'p1', modelId: 'm', text: 'hi' }, () => {});
    } finally {
      if (before === undefined) delete process.env.NEKKOD_OWNS;
      else process.env.NEKKOD_OWNS = before;
    }
    expect(seen!.facts).not.toHaveProperty('hostEvents');
  });
});

describe('the backend\'s events for the daemon (#551)', () => {
  it('leaves out the copies the daemon already has', async () => {
    const { isDaemonCopy } = await import('./daemon-caps.js');
    expect(isDaemonCopy('agentEvent', { type: 'text', sessionId: 's', delta: 'x', relayOnly: true })).toBe(true);
    expect(isDaemonCopy('limitsUpdated', { tokenKey: 'k', relayOnly: true })).toBe(true);
    expect(isDaemonCopy('agentEvent', { type: 'text', sessionId: 's', delta: 'x' })).toBe(false);
    expect(isDaemonCopy('terminalEvent', { type: 'data', terminalId: 'term_1', data: 'x' })).toBe(true);
    expect(isDaemonCopy('terminalEvent', { type: 'data', terminalId: 'agent_s1', data: 'x' })).toBe(false);
    expect(isDaemonCopy('tasksUpdated', [])).toBe(false);
  });
});

describe('mergePending', () => {
  it('lets the daemon win field by field', () => {
    const host = { a: { sessionId: 'a', question: { callId: 'q' } }, b: { sessionId: 'b', approval: { x: 1 } } } as never;
    const daemon = { a: { sessionId: 'a', approval: { y: 2 } } } as never;
    expect(mergePending(host, daemon)).toEqual({
      a: { sessionId: 'a', question: { callId: 'q' }, approval: { y: 2 } },
      b: { sessionId: 'b', approval: { x: 1 } },
    });
  });
});

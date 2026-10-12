import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ProviderConfig, Session } from '@nekko-agent/shared';
import type { Provider, ProviderChunk } from '@nekko-agent/core';

/**
 * A long agent run has to survive being cut off. These exercise the two halves
 * of that: the host writes each completed step to disk as it lands (so a run
 * killed mid-flight leaves its work behind), and resuming continues from that
 * transcript instead of re-running everything.
 *
 * The provider is scripted, so a "timeout" is just a throw, and no model is
 * needed to reproduce the failure the fix is about.
 */

/** Rounds of chunks the fake model returns, one per call; a thrown round breaks the stream. */
let rounds: Array<ProviderChunk[] | Error> = [];
let round = 0;
const daemonCall = vi.hoisted(() => vi.fn<() => unknown>(() => undefined));
vi.mock('./engine/daemon.js', async () => ({ ...(await vi.importActual<typeof import('./engine/daemon.js')>('./engine/daemon.js')), daemonCall }));

vi.mock('@nekko-agent/core', async () => {
  const actual = await vi.importActual<typeof import('@nekko-agent/core')>('@nekko-agent/core');
  return {
    ...actual,
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat() {
        const step = rounds[round++] ?? [{ type: 'done' as const }];
        if (step instanceof Error) throw step;
        for (const c of step) yield c;
      },
    }),
  };
});

const { setDataDir } = await import('./paths.js');
const { saveSettings } = await import('./store.js');
const { createSession, getSession, setSessionOptions, queuePrompt, saveSession } = await import('./sessions.js');
const { sendChat, getRunningSessionIds } = await import('./chat.js');

let dir: string;
let workspace: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-checkpoint-'));
  workspace = mkdtempSync(join(tmpdir(), 'nekko-ws-'));
  setDataDir(dir);
  saveSettings({
    workspaces: [{ id: 'w1', name: 'ws', path: workspace, addedAt: 0 }],
    providers: [{ id: 'p1', kind: 'openai-compat', label: 'Test', baseUrl: 'http://localhost:1/v1', enabled: true }],
    defaultChatMode: 'yolo', // no approval prompts in a headless test
  });
  rounds = [];
  round = 0;
  daemonCall.mockReturnValue(undefined);
});

/**
 * A failure no retry gets past. A dropped connection (`terminated`) is sent
 * again now (loop-retry.test.ts), so breaking the run for good takes a
 * rejection the loop does not retry.
 */
const FATAL = 'anthropic 400: the request was rejected';
const fatal = () => new Error(FATAL);

/** The expensive tool result whose loss is the whole complaint. */
const EXPENSIVE = 'the result that took forty minutes';

function readTool(path: string): ProviderChunk {
  return { type: 'tool_call', call: { id: 'c1', name: 'read_file', input: { path } } };
}

async function run(session: Session, opts: { resume?: boolean; text?: string } = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await sendChat(
    { sessionId: session.id, providerId: 'p1', modelId: 'm', text: opts.resume ? '' : 'do the long thing', ...opts },
    (e) => events.push(e),
  );
  return events;
}

describe('failed daemon reply start', () => {
  it('runs the reply here when the daemon refuses the turn, and clears the active reply gate', async () => {
    const session = createSession('w1');
    session.titleAuto = false; // Keep sideband title generation from consuming the scripted reply.
    saveSession(session);
    const call = vi.fn(async (channel: string) => {
      if (channel === 'daemon:info') return { owned: ['chat:turn'] };
      if (channel === 'chat:turn') throw new Error('Synthetic daemon start failure');
      return null;
    });
    daemonCall.mockReturnValue(call);
    rounds = [[{ type: 'text', delta: 'Ran in process' }, { type: 'done' }]];
    const events: AgentEvent[] = [];
    await sendChat({ sessionId: session.id, providerId: 'p1', modelId: 'm', text: 'first' }, (e) => events.push(e));
    expect(call).toHaveBeenCalledWith('chat:turn', expect.any(Object));
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(getSession(session.id)?.messages.at(-1)?.content).toBe('Ran in process');
    expect(getRunningSessionIds()).not.toContain(session.id);
    expect(getSession(session.id)?.activeRun).toBeUndefined();
    daemonCall.mockReturnValue(undefined);
  });
});

describe('a run that is cut off part-way', () => {
  it('has already written its finished steps to disk when it breaks', async () => {
    const file = join(workspace, 'notes.txt');
    writeFileSync(file, EXPENSIVE, 'utf8');
    rounds = [[readTool(file), { type: 'done' }], fatal()];

    const session = createSession('w1');
    let onDiskMidRun: Session | null = null;
    await sendChat({ sessionId: session.id, providerId: 'p1', modelId: 'm', text: 'read it' }, (e) => {
      // The moment the tool answers, before the run goes on to break: the step
      // must already be on disk, not only in memory.
      if (e.type === 'tool_result') onDiskMidRun = getSession(session.id);
    });

    expect(onDiskMidRun).not.toBeNull();
    expect(onDiskMidRun!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(onDiskMidRun!.messages[2].toolResult?.output).toContain(EXPENSIVE);
  });

  it('keeps the finished steps and the cut-off reply after it fails', async () => {
    const file = join(workspace, 'notes.txt');
    writeFileSync(file, EXPENSIVE, 'utf8');
    rounds = [[readTool(file), { type: 'done' }], fatal()];

    const session = createSession('w1');
    const events = await run(session);

    expect(events.at(-1)).toMatchObject({ type: 'error', message: FATAL });
    const saved = getSession(session.id)!;
    expect(saved.messages.some((m) => m.toolResult?.output.includes(EXPENSIVE))).toBe(true);
  });
});

describe('resuming a cut-off run', () => {
  it('saves typed continue and announces it before the next assistant reply', async () => {
    const session = createSession('w1');
    rounds = [[{ type: 'text', delta: "I'll resume directly." }, { type: 'done' }]];
    await run(session);
    round = 0;
    rounds = [[{ type: 'text', delta: "I'll pick up from here." }, { type: 'done' }]];
    let visibleAtStart: string[] = [];
    await sendChat({ sessionId: session.id, providerId: 'p1', modelId: 'm', text: 'continue', resume: true }, e => {
      if (e.type === 'session_meta' && !visibleAtStart.length) visibleAtStart = getSession(session.id)!.messages.map(m => m.content);
    });
    expect(visibleAtStart.at(-1)).toBe('continue');
    const saved = getSession(session.id)!.messages;
    const at = saved.findIndex(m => m.role === 'user' && m.content === 'continue');
    expect(at).toBeGreaterThan(0);
    expect(saved[at - 1].content).toBe("I'll resume directly.");
    expect(saved[at + 1].content).toBe("I'll pick up from here.");
  });
  it('announces normal typed turns to other mounted panes before streaming', async () => {
    const session = createSession('w1');
    rounds = [[{ type: 'text', delta: 'answer' }, { type: 'done' }]];
    const events = await run(session, { text: 'continue' });
    expect(events.findIndex(e => e.type === 'session_meta')).toBeLessThan(events.findIndex(e => e.type === 'text'));
    expect(getSession(session.id)!.messages[0].content).toBe('continue');
  });
  it('carries on without running the finished tool again', async () => {
    const file = join(workspace, 'notes.txt');
    writeFileSync(file, EXPENSIVE, 'utf8');
    rounds = [[readTool(file), { type: 'done' }], fatal()];

    const session = createSession('w1');
    await run(session);
    const afterFailure = getSession(session.id)!;
    const toolResultsBefore = afterFailure.messages.filter((m) => m.role === 'tool').length;

    // Resume: the model answers straight away, calling nothing.
    round = 0;
    rounds = [[{ type: 'text', delta: 'Finishing up from where I stopped.' }, { type: 'done' }]];
    await run(afterFailure, { resume: true });

    const resumed = getSession(session.id)!;
    // The prompt was not asked again and the tool was not re-run.
    expect(resumed.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(resumed.messages.filter((m) => m.role === 'tool')).toHaveLength(toolResultsBefore);
    expect(resumed.messages.some((m) => m.toolResult?.output.includes(EXPENSIVE))).toBe(true);
    expect(resumed.messages.at(-1)?.content).toBe('Finishing up from where I stopped.');
  });

  it('starting over instead would have thrown the work away', async () => {
    // The old Retry path: truncate back to the last user message and re-send.
    // Kept as a contrast, so the difference the fix makes is spelled out.
    const file = join(workspace, 'notes.txt');
    writeFileSync(file, EXPENSIVE, 'utf8');
    rounds = [[readTool(file), { type: 'done' }], fatal()];

    const session = createSession('w1');
    await run(session);

    const { truncateSession } = await import('./sessions.js');
    const lastUser = getSession(session.id)!.messages.find((m) => m.role === 'user')!;
    const truncated = truncateSession(session.id, lastUser.id)!;
    expect(truncated.messages.some((m) => m.toolResult?.output.includes(EXPENSIVE))).toBe(false);
  });
});

describe('complete_session', () => {
  const completeTool = (input = {}): ProviderChunk => ({ type: 'tool_call', call: { id: 'complete1', name: 'complete_session', input } });

  it('archives the current session and preserves its final transcript and queue', async () => {
    const session = createSession('w1');
    setSessionOptions(session.id, { title: 'Completion test' });
    queuePrompt(session.id, 'later task');
    rounds = [[completeTool(), { type: 'done' }], [{ type: 'text', delta: 'Completed as requested.' }, { type: 'done' }]];
    const events = await run(session);
    const saved = getSession(session.id)!;
    expect(saved.archivedAt).toBeGreaterThan(0);
    expect(saved.messages.some(m => m.content === 'Completed as requested.')).toBe(true);
    expect(saved.queue).toEqual(['later task']);
    expect(round).toBe(2);
    expect(events.some(e => e.type === 'session_meta')).toBe(true);
    expect(saved.messages.find(m => m.toolResult?.toolCallId === 'complete1')?.toolResult?.isError).not.toBe(true);
  });

  it('rejects arguments rather than completing another chat', async () => {
    const session = createSession('w1');
    rounds = [[completeTool({ sessionId: 'other' }), { type: 'done' }]];
    await run(session);
    expect(getSession(session.id)!.archivedAt).toBeFalsy();
    expect(getSession(session.id)!.messages.find(m => m.toolResult)?.toolResult?.isError).toBe(true);
  });

  it.each(['incognito', 'sub-agent', 'goal run'])('is unavailable to a %s session', async (kind) => {
    const session = createSession('w1');
    if (kind === 'incognito') session.incognito = true;
    if (kind === 'sub-agent') session.parentSessionId = 'parent';
    if (kind === 'goal run') session.trainingRunId = 'run';
    saveSession(session);
    rounds = [[completeTool(), { type: 'done' }]];
    const events = await run(session);
    expect(getSession(session.id)!.archivedAt).toBeFalsy();
    expect(events.some(e => e.type === 'tool_result' && e.result.isError)).toBe(true);
  });

  it('respects disabled tools', async () => {
    const session = createSession('w1');
    setSessionOptions(session.id, { disabledTools: ['complete_session'] });
    rounds = [[completeTool(), { type: 'done' }]];
    await run(session);
    expect(getSession(session.id)!.archivedAt).toBeFalsy();
    expect(getSession(session.id)!.messages.find(m => m.toolResult)?.toolResult?.isError).toBe(true);
  });
});

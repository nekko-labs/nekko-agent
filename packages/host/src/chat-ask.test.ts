import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ProviderConfig } from '@nekko-agent/shared';
import type { Provider, ProviderChunk } from '@nekko-agent/core';

/**
 * `ask_user` end to end through the host: the turn parks on the question, the
 * answer resolves it, and the model reads back what the user chose.
 *
 * The parking is the part worth testing. Everything else in the loop returns a
 * tool result immediately; this one returns a promise that nothing settles
 * until a person acts, which is exactly the shape that hangs forever when it
 * goes wrong.
 */

let rounds: Array<ProviderChunk[]> = [];
let toolsOffered: string[] = [];
let systemPrompts: string[] = [];

const syncMcp = vi.hoisted(() => vi.fn(async () => {}));
const mcpToolSpecs = vi.hoisted(() => vi.fn(() => [] as Array<{ name: string; description: string; parameters: { type: 'object'; properties: Record<string, never> } }>));
const isMcpTool = vi.hoisted(() => vi.fn((name: string) => name.startsWith('mcp__')));
const callMcpTool = vi.hoisted(() => vi.fn(async (call: { id: string }) => ({ toolCallId: call.id, output: 'mcp' })));

vi.mock('./spec.js', () => ({ buildSpec: vi.fn(async () => ({ ok: true })) }));
vi.mock('./mcp.js', () => ({ syncMcp, mcpToolSpecs, isMcpTool, callMcpTool }));
vi.mock('@nekko-agent/core', async () => {
  const actual = await vi.importActual<typeof import('@nekko-agent/core')>('@nekko-agent/core');
  return {
    ...actual,
    getConnector: () => ({ fetch: async () => [] }),
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(request) {
        // Sideband calls (title generation) carry no tools and no system
        // prompt; capturing them would overwrite the turn's real records.
        if (request.purpose !== 'title') {
          toolsOffered = (request.tools ?? []).map((t) => t.name);
          systemPrompts.push(request.system ?? '');
        }
        const step = rounds.shift() ?? [{ type: 'text', delta: 'ok' }, { type: 'done' }];
        for (const chunk of step) yield chunk;
      },
    }),
  };
});

const { setDataDir } = await import('./paths.js');
const { saveSettings } = await import('./store.js');
const { createSession, getSession, saveSession, setSessionOptions } = await import('./sessions.js');
const { sendChat, resolveQuestion, resolveApproval, getHostPendingInput } = await import('./chat.js');

let dir: string;

const ASK_ROUND = (input: unknown): ProviderChunk[] => [
  { type: 'tool_call', call: { id: 'ask1', name: 'ask_user', input: input as Record<string, unknown> } },
  { type: 'done' },
];

const GOOD_QUESTION = {
  questions: [
    {
      header: 'Scope',
      question: 'How far should this go?',
      options: [{ label: 'Just the parser' }, { label: 'The whole module' }],
    },
  ],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-ask-'));
  setDataDir(dir);
  saveSettings({
    providers: [{ id: 'p', kind: 'anthropic', label: 'P', baseUrl: 'https://example.test', apiKey: 'k', enabled: true }],
    workspaces: [],
    defaultChatMode: 'yolo',
  });
  rounds = [];
  toolsOffered = [];
  systemPrompts = [];
  vi.clearAllMocks();
  mcpToolSpecs.mockReturnValue([]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const send = (sessionId: string, onEvent: (e: AgentEvent) => void) =>
  sendChat({ sessionId, providerId: 'p', modelId: 'm', text: 'do the thing' }, onEvent);

describe('live approval policy', () => {
  it('allows remaining approvals in the current turn without changing other chats', async () => {
    const session = createSession();
    setSessionOptions(session.id, { mode: 'ask' });
    const other = createSession();
    setSessionOptions(other.id, { mode: 'ask' });
    const round = (id: string): ProviderChunk[] => [
      { type: 'tool_call', call: { id, name: 'write_file', input: { path: join(dir, `${id}.txt`), content: 'ok' } } },
      { type: 'done' },
    ];
    rounds = [round('first'), round('second'), [{ type: 'text', delta: 'done' }, { type: 'done' }]];
    const approvals: string[] = [];
    await send(session.id, (e) => {
      if (e.type === 'tool_approval_required') {
        approvals.push(e.call.id);
        setSessionOptions(session.id, { mode: 'yolo' });
        resolveApproval(session.id, e.call.id, true);
      }
    });
    expect(approvals).toEqual(['first']);
    expect(getSession(session.id)?.mode).toBe('yolo');
    expect(getSession(other.id)?.mode).toBe('ask');
  });
});

describe('ask_user', () => {
  it('parks the turn until someone answers, then hands the answers to the model', async () => {
    const session = createSession();
    rounds = [ASK_ROUND(GOOD_QUESTION), [{ type: 'text', delta: 'understood' }, { type: 'done' }]];

    const events: AgentEvent[] = [];
    const turn = send(session.id, (e) => {
      events.push(e);
      if (e.type === 'question') {
        // Mid-flight, the host can say what this session is waiting on — which
        // is what the board reads when it opens.
        expect(getHostPendingInput()[session.id]?.question?.callId).toBe('ask1');
        resolveQuestion(session.id, e.request.callId, [
          { questionId: e.request.questions[0].id, labels: ['Just the parser'], note: 'and nothing else' },
        ]);
      }
    });

    // Nothing is waiting once the turn has finished.
    await turn;
    expect(getHostPendingInput()[session.id]).toBeUndefined();

    expect(events.find((e) => e.type === 'question')).toBeTruthy();
    expect(events.find((e) => e.type === 'question_resolved')).toMatchObject({ callId: 'ask1' });

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({
      result: { toolCallId: 'ask1', output: expect.stringContaining('Just the parser') },
    });
    expect((result as { result: { output: string } }).result.output).toContain('and nothing else');
  });

  it('tells the agent to choose when nobody answers', async () => {
    const session = createSession();
    rounds = [ASK_ROUND(GOOD_QUESTION), [{ type: 'text', delta: 'chose for you' }, { type: 'done' }]];

    const events: AgentEvent[] = [];
    await send(session.id, (e) => {
      events.push(e);
      if (e.type === 'question') resolveQuestion(session.id, e.request.callId, []);
    });

    const result = events.find((e) => e.type === 'tool_result') as { result: { output: string } } | undefined;
    expect(result?.result.output).toMatch(/did not answer/i);
    expect(result?.result.output).toMatch(/pick the most reasonable option/i);
  });

  it('answers a malformed call with something the model can fix', async () => {
    const session = createSession();
    // One option is not a question. The turn must not park on it.
    rounds = [
      ASK_ROUND({ questions: [{ header: 'X', question: 'Shall I?', options: ['Yes'] }] }),
      [{ type: 'text', delta: 'carrying on' }, { type: 'done' }],
    ];

    const events: AgentEvent[] = [];
    await send(session.id, (e) => events.push(e));

    expect(events.find((e) => e.type === 'question')).toBeUndefined();
    const result = events.find((e) => e.type === 'tool_result') as { result: { output: string } } | undefined;
    expect(result?.result.output).toMatch(/at least 2/);
  });

  it('offers the tool, and its guidance, only where a person can answer', async () => {
    const chat = createSession();
    await send(chat.id, () => {});
    expect(toolsOffered).toContain('ask_user');
    expect(systemPrompts[systemPrompts.length - 1]).toContain('Asking first:');

    // A sub-agent has nobody reading it, so a question would hang the run.
    const child = createSession();
    child.parentSessionId = chat.id;
    saveSession(child);
    await send(child.id, () => {});
    expect(toolsOffered).not.toContain('ask_user');
    expect(systemPrompts[systemPrompts.length - 1]).not.toContain('Asking first:');

    // Same for an automation.
    const task = createSession();
    task.taskId = 'task_1';
    saveSession(task);
    await send(task.id, () => {});
    expect(toolsOffered).not.toContain('ask_user');
  });

  it('lets go of the question when the run is stopped', async () => {
    const { abortChat } = await import('./chat.js');
    const session = createSession();
    rounds = [ASK_ROUND(GOOD_QUESTION), [{ type: 'text', delta: 'stopped' }, { type: 'done' }]];

    await send(session.id, (e) => {
      // Stopping has to settle the promise the loop is parked on, or the turn
      // never ends and the session is stuck until the app restarts.
      if (e.type === 'question') abortChat(session.id);
    });

    expect(getHostPendingInput()[session.id]).toBeUndefined();
    expect(getSession(session.id)).toBeTruthy();
  });
});

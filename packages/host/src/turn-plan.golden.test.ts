import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskAnswer, ChatMessage, SendOptions, Session } from '@nekko-agent/shared';
import {
  ASK_CANCELLED,
  ASK_UNATTENDED,
  DEFAULT_ORCHESTRATION,
  DEFAULT_TURN_WRAPPER,
  OFFLINE_BLOCKED_AGENT_TOOLS,
  ORCHESTRATION_STRATEGIES,
  TOOL_CATEGORY_OF,
  TurnStatsAccumulator,
  applyPlanUpdate,
  attachTurnStats,
  formatAskAnswers,
  parseAskRequest,
  planEcho,
  workModePrompts,
} from '@nekko-agent/shared';
import {
  AGENT_WATCH_INSTRUCTIONS,
  SANDBOX_INSTRUCTIONS,
  applyTurnInput,
  cleanTitle,
  hostToolApproval,
  sendOptionsForQueuedItem,
  titlePrompt,
  turnSystemPrompt,
  turnToolCatalog,
  turnTools,
} from './turn-plan.js';

/**
 * What the pure half of a chat turn produces, which the engine daemon's port
 * (crates/nekko-turn) must reproduce exactly: the tool list, the system
 * prompt, the transcript after the user's input, the title prompt and its
 * cleaning, queued prompts, `ask_user` parsing and answers, `update_plan`,
 * and per-turn stats. Also writes the tool catalog and text the daemon embeds
 * (crates/nekko-turn/src/catalog.json). Fails if either file is stale;
 * rewrite them with UPDATE_GOLDEN=1.
 */
const crate = join(__dirname, '..', '..', '..', 'crates', 'nekko-turn');

function check(path: string, actual: unknown): void {
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(actual, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
}

const NOW = 1_760_000_000_000;

const mcp = [
  { name: 'mcp__files__read', description: 'Read through MCP', parameters: { type: 'object', properties: { p: { type: 'string' } } } },
  { name: 'mcp__web__get', description: 'Fetch', parameters: { type: 'object' } },
];

function toolCases() {
  const sessions: Array<Partial<Session>> = [
    {},
    { titleAuto: false },
    { titleAuto: true },
    { incognito: true },
    { parentSessionId: 's_parent' },
    { taskId: 't1' },
    { trainingRunId: 'r1' },
    { disabledTools: ['bash', 'spawn_agent', 'ask_user'] },
    { disabledTools: ['complete_session', 'decide', 'delegation_targets', 'browser'] },
    { disabledTools: ['update_plan', 'set_chat_title', 'agent_watch', 'mcp__web__get'] },
    { trainingRunId: 'r2', incognito: true, titleAuto: false },
  ];
  const out: Array<{ input: unknown; output: unknown }> = [];
  for (const session of sessions) {
    for (const strategy of [undefined, 'solo', 'balanced', 'swarm'] as const) {
      for (const allowBrowserControl of [false, true]) {
        const input = {
          session,
          offline: false,
          ...(strategy ? { orchestration: { ...DEFAULT_ORCHESTRATION, strategy } } : {}),
          allowBrowserControl,
          mcpTools: strategy === 'swarm' ? mcp : [],
          decide: allowBrowserControl,
        };
        out.push({ input, output: turnTools(input as never).map((t) => t.name) });
      }
    }
  }
  // Blocking the internet keeps the local tools and drops the online ones.
  for (const session of [{}, { disabledTools: ['bash', 'grep'] }, { parentSessionId: 's_parent' }, { incognito: true }]) {
    for (const strategy of ['solo', 'swarm'] as const) {
      const offline = { session, offline: true, orchestration: { ...DEFAULT_ORCHESTRATION, strategy }, allowBrowserControl: true, mcpTools: mcp, decide: true };
      out.push({ input: offline, output: turnTools(offline as never).map((t) => t.name) });
    }
  }
  // A tools-off turn (a workflow step reading untrusted text) offers nothing that acts.
  for (const session of [{}, { trainingRunId: 'r1' }]) {
    const off = { session, offline: false, orchestration: { ...DEFAULT_ORCHESTRATION, strategy: 'swarm' }, allowBrowserControl: true, mcpTools: mcp, decide: true, noTools: true };
    out.push({ input: off, output: turnTools(off as never).map((t) => t.name) });
  }
  return out;
}

function promptCases() {
  const providers = [
    { id: 'p1', label: 'Local llama', enabled: true, baseUrl: 'http://127.0.0.1:8080/v1' },
    { id: 'p2', label: 'Cloud sk-secret-123 (https://api.example.com/v1)', enabled: true, apiKey: 'sk-secret-123', baseUrl: 'https://api.example.com/v1' },
    { id: 'p3', label: 'Off', enabled: false },
  ];
  const workspaces = [
    { name: 'app', path: 'C:\\code\\app' },
    { name: 'docs', path: '/home/me/docs' },
  ];
  const base = { workspaces, tools: [{ name: 'read_file' }], settings: { providers }, sandbox: false, executionMode: 'worktree', worktreeNotices: [], contextBlock: '', platform: 'win32' };
  const variants: Array<Record<string, unknown>> = [
    {},
    { workspaces: [] },
    { tools: [{ name: 'ask_user' }, { name: 'update_plan' }] },
    { tools: [{ name: 'spawn_agent' }, { name: 'agent_watch' }] },
    { tools: [{ name: 'spawn_agent' }], settings: { providers, orchestration: { strategy: 'swarm', maxDepth: 1, maxParallel: 3, delegationRoute: { providerId: 'p2', modelId: 'https://api.example.com/v1/x' } } } },
    { tools: [{ name: 'spawn_agent' }], settings: { providers, orchestration: { strategy: 'solo', maxDepth: 2, maxParallel: 4 } } },
    { tools: [{ name: 'agent_watch' }], settings: { providers, systemInstructions: '  Be terse.  ' } },
    { settings: { providers, systemInstructions: '   ', turnWrapper: '', aboutUser: ' Philip, likes tables ' } },
    { settings: { providers, turnWrapper: 'Custom wrapper\nline two' } },
    { executionMode: 'unified', worktreeNotices: ['ignored'] },
    { worktreeNotices: ['Worktree A on branch x.', 'Worktree B.'] },
    { contextBlock: '<guideline path="AGENTS.md">\nhi\n</guideline>', platform: 'darwin' },
    { workMode: 'better-review' },
    { workMode: 'design', tools: [{ name: 'agent_watch' }], settings: { providers, systemInstructions: 'Be terse.' } },
    { workMode: 'best-output', sandbox: true, executionMode: 'sandbox' },
    { workMode: 'default' },
    { workMode: 'no-such-mode' },
  ];
  return variants.map((v) => {
    const input = { ...base, ...v };
    return { input, output: turnSystemPrompt(input as never) };
  });
}

function inputCases() {
  const history = (): ChatMessage[] => [
    { id: 'u1', role: 'user', content: 'first', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'working', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a' } }], createdAt: 2 },
  ];
  const compacted = (): ChatMessage[] => [
    { id: 'u0', role: 'user', content: 'old', createdAt: 1 },
    { id: 'k', role: 'assistant', content: 'summary', compaction: { coveredCount: 1, createdAt: 3 }, createdAt: 3 } as ChatMessage,
    { id: 't', role: 'tool', content: 'x', toolCallId: 'c', createdAt: 4 } as ChatMessage,
  ];
  const cases: Array<{ session: Partial<Session>; opts: Partial<SendOptions> }> = [
    { session: { title: 'New chat', messages: [] }, opts: { text: 'Fix the login bug please, the one where the form resets' } },
    { session: { title: 'New chat', messages: [] }, opts: { text: '', images: ['data:image/png;base64,AAAA'] } },
    { session: { title: 'Named', titleAuto: false, messages: history() }, opts: { text: 'more', skill: { name: 'review', input: 'more' } } },
    { session: { title: 'Named', messages: history() }, opts: { text: 'ignored', resume: true } },
    { session: { title: 'Named', messages: history() }, opts: { text: '   ', resume: true } },
    { session: { title: 'Named', messages: history() }, opts: { text: 'and also', resume: true } },
    { session: { title: 'Named', messages: [...history(), { id: 'a2', role: 'assistant', content: 'done', createdAt: 5 }] }, opts: { text: 'x', regenerate: true } },
    { session: { title: 'Named', messages: compacted() }, opts: { text: '', regenerate: true } },
    { session: { title: 'Named', messages: history() }, opts: { text: '', regenerate: true, resume: true } },
  ];
  return cases.map(({ session, opts }) => {
    const s = { id: 's_x', createdAt: 0, updatedAt: 0, ...structuredClone(session) } as Session;
    const o = { sessionId: 's_x', providerId: 'p1', modelId: 'm1', ...opts } as SendOptions;
    applyTurnInput(s, o, NOW);
    const out = JSON.parse(JSON.stringify(s).replace(/msg_repair_\d+/g, 'msg_repair_N'));
    return { input: { session: { id: 's_x', createdAt: 0, updatedAt: 0, ...session }, opts: o }, output: out };
  });
}

function titleCases() {
  const m = (role: 'user' | 'assistant', content: string): ChatMessage => ({ id: role, role, content, createdAt: 1 });
  const long = 'x'.repeat(700);
  const lists: ChatMessage[][] = [
    [],
    [m('user', '   ')],
    [m('user', 'Fix login')],
    [m('user', `Plan ${long} 😀`), m('assistant', 'first'), m('assistant', `   `), m('assistant', `Did it ${long}`)],
    [m('assistant', 'only me')],
  ];
  return lists.map((messages) => ({ input: messages, output: titlePrompt(messages) }));
}

function cleanCases() {
  const raw = ['"Fix the login form"', '  Title:  with   spaces\n', 'Ends badly...!?', 'Dash \u2013\u2014', `\`quoted\` 'single'`, 'y'.repeat(80), '', '...', 'Emoji 😀 title.'];
  return raw.map((input) => ({ input, output: cleanTitle(input) }));
}

function queuedCases() {
  const base = { sessionId: 's', providerId: 'p', modelId: 'm', text: '' } as SendOptions;
  const items = ['plain', { text: 'with media', images: ['i1'] }, { text: 'skill', skill: { name: 'review', input: 'x' } }];
  return items.map((item) => ({ input: item, output: sendOptionsForQueuedItem(base, item as never) }));
}

function askCases() {
  const inputs: unknown[] = [
    undefined,
    'not an object',
    { questions: [] },
    { questions: [{ question: '  ', options: ['a', 'b'] }] },
    { questions: [{ question: 'Which?', options: ['only'] }] },
    { questions: [{ question: 'Which auth method should the app use for the new login flow?', header: '  ', options: [' OAuth ', { label: 'Password', description: '  classic ' }, { label: '' }, 3, null, 'Magic link', 'SSO', 'Passkey', 'Other'] , multiSelect: true }] },
    { questions: [1, 2, 3, 4, 5].map((n) => ({ question: `Q${n}`, header: `H${n}`, options: ['x', 'y'], multiSelect: 'yes' })) },
  ];
  const parsed = inputs.map((input) => ({ input, output: parseAskRequest('call_1', input, NOW) }));
  const request = (parsed[5].output as { request: Parameters<typeof formatAskAnswers>[0] }).request;
  const answerSets: AskAnswer[][] = [
    [],
    [{ questionId: 'q1', labels: ['OAuth', '', 'SSO'], note: '  and keep it simple ' }],
    [{ questionId: 'q1', labels: [], note: '   ' }],
    [{ questionId: 'zz', labels: ['x'] }],
  ];
  const formatted = answerSets.map((answers) => ({ input: answers, output: formatAskAnswers(request, answers) }));
  return { parsed, request, formatted };
}

function planCases() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const step = (id: string, title: string, status: string, extra = {}) => ({ id, title, status, createdAt: 1, updatedAt: 1, ...extra });
  const current = [step('step_1', 'Read the code', 'done', { note: 'ok' }), step('step_2', 'Write it', 'active'), step('step_3', 'Test', 'pending'), step('step_4', 'Skip me', 'skipped')];
  const cases: Array<{ current: unknown; input: unknown }> = [
    { current: undefined, input: {} },
    { current: undefined, input: { steps: [{ title: '  Inspect  ' }, { title: 'Build', status: 'active' }, { title: '' }, { id: 'custom', title: 'Ship', status: 'bogus', note: ' n ' }] } },
    { current, input: { steps: [{ id: 'step_2', status: 'done', note: '  verified  ' }, { title: 'TEST', status: 'skipped' }, { title: 'New thing' }] } },
    { current, input: { replace: true, steps: [{ id: 'step_1', title: 'Different title', status: 'pending' }, { title: 'read the code', status: 'pending' }, { id: 'step_1', title: 'Fresh' }] } },
    { current, input: { replace: true, steps: [{ title: 'x'.repeat(200), note: 'n'.repeat(300) }, { title: 7 }, { title: null, id: 'step_3' }, { title: ['a', 'b'] }, { title: { a: 1 } }] } },
    { current: [step('step_1', 'Only', 'pending')], input: { steps: [{ id: 'step_1', title: '' }] } },
    { current: [], input: { steps: [{ title: '' }] } },
  ];
  const out = cases.map((c) => {
    const result = applyPlanUpdate(structuredClone(c.current) as never, c.input as never);
    return { input: c, output: 'error' in result ? result : { ...result, echo: planEcho(result.plan) } };
  });
  vi.useRealTimers();
  return out;
}

function statsCases() {
  const runs: Array<{ identity: Record<string, unknown>; usage: Array<Record<string, number | undefined>>; end?: Record<string, unknown>; endedAt: number }> = [
    { identity: { providerId: 'p', modelId: 'm', effort: 'normal' }, usage: [], endedAt: NOW },
    { identity: { providerId: 'p', modelId: 'm', effort: 'high' }, usage: [{ inputTokens: 10, outputTokens: 5 }, { inputTokens: 3, outputTokens: 2, cacheReadTokens: 7, outputMs: 120 }], end: { steps: 2, stop: 'complete' }, endedAt: NOW + 1500 },
    { identity: { providerId: 'p', modelId: 'm' }, usage: [{ inputTokens: 1, outputTokens: 1, cacheWriteTokens: 4, outputMs: 0 }], end: { steps: 0 }, endedAt: NOW - 5 },
  ];
  return runs.map((r) => {
    const acc = new TurnStatsAccumulator(r.identity as never, NOW);
    for (const u of r.usage) acc.add(u);
    const stats = acc.finish(r.endedAt, r.end as never);
    const messages: ChatMessage[] = [
      { id: 'a0', role: 'assistant', content: 'before', createdAt: 1 },
      { id: 'u', role: 'user', content: 'q', createdAt: 2 },
      { id: 'a1', role: 'assistant', content: 'x', createdAt: 3 },
      { id: 't', role: 'tool', content: 'r', toolCallId: 'c', createdAt: 4 } as ChatMessage,
    ];
    const attachedAt1 = stats ? attachTurnStats(messages, 1, stats) : null;
    const none = structuredClone(messages.slice(0, 2));
    const attachedNone = stats ? attachTurnStats(none, 2, stats) : null;
    return { input: { ...r, startedAt: NOW }, output: { stats: stats ?? null, attachedAt1, messages, attachedNone } };
  });
}

function approvalCases() {
  const out = [];
  for (const name of ['spawn_agent', 'mcp__files__read', 'mcp__', 'mcp_files', 'read_file', 'browser'])
    for (const mode of ['ask', 'guardrails', 'yolo', undefined])
      for (const sandboxMode of ['workspace-jail', 'ask-everything', undefined])
        out.push({ input: { name, mode: mode ?? null, sandboxMode: sandboxMode ?? null }, output: hostToolApproval(name, mode, sandboxMode) });
  return out;
}

describe('turn plan golden set', () => {
  afterEach(() => vi.useRealTimers());

  it('writes the catalog the daemon embeds', () => {
    check(join(crate, 'src', 'catalog.json'), {
      tools: turnToolCatalog(),
      defaultTurnWrapper: DEFAULT_TURN_WRAPPER,
      strategies: ORCHESTRATION_STRATEGIES.map((s) => ({ id: s.id, allowsSpawn: s.allowsSpawn, promptHint: s.promptHint })),
      defaultOrchestration: DEFAULT_ORCHESTRATION,
      agentWatchInstructions: AGENT_WATCH_INSTRUCTIONS,
      sandboxInstructions: SANDBOX_INSTRUCTIONS,
      askCancelled: ASK_CANCELLED,
      askUnattended: ASK_UNATTENDED,
      toolCategories: TOOL_CATEGORY_OF,
      offlineBlockedTools: OFFLINE_BLOCKED_AGENT_TOOLS,
      workModePrompts: workModePrompts(),
    });
  });

  it('matches what the TS turn functions produce', () => {
    check(join(crate, 'tests', 'golden', 'expected.json'), {
      tools: toolCases(),
      prompts: promptCases(),
      inputs: inputCases(),
      titles: titleCases(),
      cleans: cleanCases(),
      queued: queuedCases(),
      ask: askCases(),
      plans: planCases(),
      stats: statsCases(),
      approvals: approvalCases(),
    });
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ModelInfo, ProviderConfig, Session } from '@nekko-agent/shared';
import type { ChatRequest, Provider, ProviderChunk } from '@nekko-agent/core';

let requests: Array<{ providerId: string; request: ChatRequest }> = [];
let titleRequests: Array<{ providerId: string; request: ChatRequest }> = [];
let suggestRequests: Array<{ providerId: string; request: ChatRequest }> = [];
let suggestError: Error | null = null;
let fillRequests: Array<{ providerId: string; request: ChatRequest }> = [];
let fillError: Error | null = null;
let listings: string[] = [];
let rounds: Array<ProviderChunk[] | Error> = [];
let models: ModelInfo[] = [];
let listingError = false;
const buildSpec = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const syncMcp = vi.hoisted(() => vi.fn(async () => {}));
const mcpToolSpecs = vi.hoisted(() => vi.fn(() => [] as Array<{ name: string; description: string; parameters: { type: 'object'; properties: Record<string, never> } }>));
const isMcpTool = vi.hoisted(() => vi.fn((name: string) => name.startsWith('mcp__')));
const callMcpTool = vi.hoisted(() => vi.fn(async (call: { id: string }) => ({ toolCallId: call.id, output: 'mcp result' })));
const connectorFetch = vi.hoisted(() => vi.fn(async () => []));

vi.mock('./spec.js', () => ({ buildSpec }));
vi.mock('./mcp.js', () => ({ syncMcp, mcpToolSpecs, isMcpTool, callMcpTool }));
vi.mock('@nekko-agent/core', async () => {
  const actual = await vi.importActual<typeof import('@nekko-agent/core')>('@nekko-agent/core');
  return {
    ...actual,
    getConnector: () => ({ fetch: connectorFetch }),
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      async listModels() {
        listings.push(config.id);
        if (listingError) throw new Error('private-token https://private.example/models');
        return models;
      },
      test: async () => ({ ok: true, message: '' }),
      async *chat(request) {
        // Sideband calls (title generation, reply suggestions) are recorded
        // separately so the turn-traffic assertions below stay about routing.
        if (request.purpose === 'title') {
          titleRequests.push({ providerId: config.id, request });
        } else if (request.purpose === 'suggest') {
          suggestRequests.push({ providerId: config.id, request });
          // A fire-and-forget titleSession from a previous test can bleed into
          // this one and eat a queued round, so suggestion traffic gets a
          // purpose-keyed default rather than sharing `rounds`.
          if (suggestError) throw suggestError;
          for (const chunk of [{ type: 'text', delta: '{"options":["Run the tests","Explain the diff"],"next":"Run the new tests"}' }, { type: 'done' }] as ProviderChunk[]) yield chunk;
          return;
        } else if (request.purpose === 'fill') {
          fillRequests.push({ providerId: config.id, request });
          if (fillError) throw fillError;
          for (const chunk of [{ type: 'text', delta: 'You are a senior reviewer for this codebase.' }, { type: 'done' }] as ProviderChunk[]) yield chunk;
          return;
        } else {
          requests.push({ providerId: config.id, request });
        }
        const step = rounds.shift() ?? [{ type: 'text', delta: 'answer' }, { type: 'done' }];
        if (step instanceof Error) throw step;
        for (const chunk of step) yield chunk;
      },
    }),
  };
});

const { setDataDir } = await import('./paths.js');
const { saveSettings, getSettings } = await import('./store.js');
const { executeTool } = await import('./tools.js');
const { terminalSnapshot, writeTerminal, closeTerminal } = await import('./terminal.js');
const { createSession, getSession, saveSession, listSessions } = await import('./sessions.js');
const { sendChat, previewContext, resolveApproval, suggestReplies, fillPromptPart } = await import('./chat.js');
const { flushAgentLogs } = await import('./agent-log.js');
const { BUILTIN_TOOLS } = await import('@nekko-agent/core');
let dir: string;
let providers: ProviderConfig[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-routing-'));
  setDataDir(dir);
  providers = [
    { id: 'frontier', kind: 'anthropic', label: 'Frontier', baseUrl: 'https://private.example', apiKey: 'private-token', enabled: true },
    { id: 'local', kind: 'openai-compat', label: 'Local worker', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true },
    { id: 'disabled', kind: 'ollama', label: 'Disabled worker', baseUrl: 'http://localhost:11434', enabled: false },
  ];
  saveSettings({ providers, workspaces: [], defaultChatMode: 'yolo' });
  requests = [];
  titleRequests = [];
  suggestRequests = [];
  suggestError = null;
  fillRequests = [];
  fillError = null;
  listings = [];
  rounds = [];
  models = [{ id: 'local-exact', providerId: 'local', name: 'Local exact' }];
  listingError = false;
  vi.clearAllMocks();
  mcpToolSpecs.mockReturnValue([]);
});

// Command-log sidecars are written asynchronously (agent-log.ts): a test that
// returns as soon as its shell is cancelled can still have an append queued,
// which recreated `sessions/` under the directory being removed (ENOTEMPTY).
// Drain them first, and retry for a child process still releasing a handle.
afterEach(async () => {
  await flushAgentLogs().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

it('propagates off through chat and sideband calls and preserves cache usage', async () => {
  saveSettings({ promptCaching: false });
  rounds = [[{ type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 20 }, { type: 'text', delta: 'done' }, { type: 'done' }]];
  const { session, events } = await run();
  expect(requests[0].request.promptCaching).toBe(false);
  expect(events.find(e => e.type === 'usage')).toMatchObject({ cacheReadTokens: 30, cacheWriteTokens: 20 });
  await suggestReplies(session.id);
  await fillPromptPart(session.id, 'Role', 'review');
  expect(suggestRequests[0].request.promptCaching).toBe(false);
  expect(fillRequests[0].request.promptCaching).toBe(false);
});

it('keeps the reply stats on the saved answer and in the reply log', async () => {
  saveSettings({ effort: 'high' });
  rounds = [[{ type: 'usage', inputTokens: 120, outputTokens: 40, cacheReadTokens: 900 }, { type: 'text', delta: 'answer' }, { type: 'done' }]];
  const { session } = await run();
  const saved = getSession(session.id)!;
  const answer = [...saved.messages].reverse().find((m) => m.role === 'assistant')!;
  expect(answer.turnStats).toMatchObject({ providerId: requests[0].providerId, modelId: requests[0].request.model, inputTokens: 120, outputTokens: 40, cacheReadTokens: 900, calls: 1 });
  expect(answer.turnStats!.effort).toBeTruthy();
  // Only the answer carries them; the user's message does not.
  expect(saved.messages.filter((m) => m.turnStats)).toHaveLength(1);
  const { readFileSync, existsSync } = await import('node:fs');
  const log = join(dir, 'replies.jsonl');
  if (existsSync(log)) {
    const last = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()!);
    expect(last).toMatchObject({ sessionId: session.id, inputTokens: 120, outputTokens: 40 });
    expect(JSON.stringify(last)).not.toContain('answer');
  }
});

function delegate(input: unknown) {
  rounds = [[{ type: 'tool_call', call: { id: 'spawn1', name: 'spawn_agent', input: input as Record<string, unknown> } }, { type: 'done' }]];
}

async function run(session = createSession(), providerId = 'frontier', modelId = 'frontier-exact') {
  const events: AgentEvent[] = [];
  await sendChat({ sessionId: session.id, providerId, modelId, text: 'delegate this' }, (event) => events.push(event));
  return { session, events, result: events.find((event) => event.type === 'tool_result' && event.sessionId === session.id) };
}

function children(parent: Session) {
  return listSessions().filter((session) => session.parentSessionId === parent.id);
}

describe('agent command terminal', () => {
  it('cancels a running fallback shell instead of waiting for its command', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const call = { id: 'slow', name: 'bash', input: { command: 'node -e "setTimeout(() => {}, 30000)"' } };
    const result = executeTool(call, { settings: getSettings(), sessionId: 'test-cancel', mode: 'yolo', signal: controller.signal, requestApproval: async () => false });
    setTimeout(() => controller.abort(), 100);
    expect(await result).toMatchObject({ isError: true, output: expect.stringContaining('Command cancelled.') });
    expect(Date.now() - started).toBeLessThan(5000);
    closeTerminal('agent_test-cancel');
  });

  it('preserves quoted shell arguments and stderr', async () => {
    const result = await executeTool({ id: 'quoted', name: 'bash', input: { command: 'node -e "console.log(\'two words\'); console.error(\'error words\')"' } },
      { settings: getSettings(), mode: 'yolo', requestApproval: async () => false });
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('two words');
    expect(result.output).toContain('[stderr]');
    expect(result.output).toContain('error words');
  });

  it('does not start a shell after its turn was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeTool({ id: 'cancelled', name: 'bash', input: { command: 'node -p 42' } },
      { settings: getSettings(), sessionId: 'test-cancelled', mode: 'yolo', signal: controller.signal, requestApproval: async () => false });
    expect(result).toMatchObject({ isError: true, output: 'Command cancelled.' });
    expect(await terminalSnapshot('agent_test-cancelled')).toBeNull();
  });

  it('shows a guarded command once in a read-only terminal', async () => {
    const sessionId = 'test-command';
    const call = { id: 'cmd', name: 'bash', input: { command: 'node -p 42' } };
    const result = await executeTool(call, { settings: getSettings(), sessionId, mode: 'yolo', requestApproval: async () => false });
    const snapshot = await terminalSnapshot(`agent_${sessionId}`);
    expect(result.output.trim()).toBe('42');
    expect(snapshot?.info.agentSessionId).toBe(sessionId);
    expect(snapshot?.buffer).toContain('$ node -p 42');
    expect(snapshot?.buffer).toContain('42');
    writeTerminal(`agent_${sessionId}`, 'ignored');
    expect((await terminalSnapshot(`agent_${sessionId}`))?.buffer).toBe(snapshot?.buffer);
    closeTerminal(`agent_${sessionId}`);
  });
});

describe('browser permission boundary', () => {
  it('honors allow-all for desktop browser calls without another prompt', async () => {
    const session = createSession();
    rounds = [[{ type: 'tool_call', call: { id: 'browse-yolo', name: 'browser', input: { mode: 'dedicated', action: 'close' } } }, { type: 'done' }]];
    vi.stubEnv('NEKKO_BROWSER_URL', 'http://127.0.0.1:12345/');
    vi.stubEnv('NEKKO_BROWSER_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ output: 'Closed' }) })));
    const events: AgentEvent[] = [];
    try {
      await sendChat({ sessionId: session.id, providerId: 'frontier', modelId: 'frontier-exact', text: 'close browser' }, (event) => { events.push(event); }, true);
      expect(events.some((event) => event.type === 'tool_approval_required')).toBe(false);
      expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ result: { output: 'Closed' } });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it('hides browser control on non-desktop hosts and requests approval in guardrails mode', async () => {
    const session = createSession();
    session.mode = 'guardrails';
    saveSession(session);
    rounds = [[{ type: 'tool_call', call: { id: 'browse', name: 'browser', input: { mode: 'existing', action: 'inspect' } } }, { type: 'done' }]];
    await run(session);
    expect(requests[0].request.tools?.some((tool) => tool.name === 'browser')).toBe(false);

    rounds = [[{ type: 'tool_call', call: { id: 'browse2', name: 'browser', input: { mode: 'existing', action: 'inspect' } } }, { type: 'done' }]];
    const events: AgentEvent[] = [];
    const requestCount = requests.length;
    await sendChat({ sessionId: session.id, providerId: 'frontier', modelId: 'frontier-exact', text: 'inspect' }, (event) => {
      events.push(event);
      if (event.type === 'tool_approval_required') resolveApproval(session.id, event.call.id, false);
    }, true);
    expect(requests.slice(requestCount).some(({ request }) => request.tools?.some((tool) => tool.name === 'browser'))).toBe(true);
    expect(events.some((event) => event.type === 'tool_approval_required')).toBe(true);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ result: { output: 'Browser action not approved.', isError: true } });
  });
});

describe('offline context preview', () => {
  it('does not fetch connectors for an offline session or missing session', async () => {
    saveSettings({ connectors: [{ kind: 'slack', connected: true, token: 'test-token' }] });
    const session = createSession();
    session.offline = true;
    saveSession(session);
    await previewContext(session.id, []);
    await previewContext('missing-session', []);
    expect(connectorFetch).not.toHaveBeenCalled();
  });

  it('keeps connector previews available for an online session', async () => {
    saveSettings({ connectors: [{ kind: 'slack', connected: true, token: 'test-token' }] });
    await previewContext(createSession().id, []);
    expect(connectorFetch).toHaveBeenCalledOnce();
  });
});

describe('delegation discovery and defaults', () => {
  it('discovers exact models on only the requested provider without creating children', async () => {
    rounds = [[{ type: 'tool_call', call: { id: 'discover', name: 'delegation_targets', input: { provider_id: 'local' } } }, { type: 'done' }]];
    const { session, result } = await run();
    expect(listings).toEqual(['local']);
    expect(children(session)).toHaveLength(0);
    expect(result).toMatchObject({ result: { output: expect.stringContaining('"modelId":"local-exact"') } });
  });

  it('reports discovery failure without leaking provider secrets', async () => {
    listingError = true;
    rounds = [[{ type: 'tool_call', call: { id: 'discover', name: 'delegation_targets', input: { provider_id: 'local' } } }, { type: 'done' }]];
    const { result } = await run();
    expect(result).toMatchObject({ result: { isError: true, output: expect.stringContaining('model_list_unavailable') } });
    expect(JSON.stringify(result)).not.toMatch(/private-token|private\.example/);
  });

  it('uses and validates an explicit user default without falling back', async () => {
    saveSettings({ orchestration: { strategy: 'balanced', maxDepth: 2, maxParallel: 4, delegationRoute: { providerId: 'local', modelId: 'local-exact' } } });
    delegate({ task: 'child task' });
    const { session } = await run();
    expect(children(session)[0]).toMatchObject({ providerId: 'local', modelId: 'local-exact' });
    // The default is validated against its own provider only; the child's turn
    // may list that provider again to learn the loaded context window.
    expect(listings.length).toBeGreaterThan(0);
    expect(new Set(listings)).toEqual(new Set(['local']));
  });

  it('rejects a stale default without creating a child or trying another provider', async () => {
    saveSettings({ orchestration: { strategy: 'balanced', maxDepth: 2, maxParallel: 4, delegationRoute: { providerId: 'local', modelId: 'missing' } } });
    delegate({ task: 'child task' });
    const { session, result } = await run();
    expect(children(session)).toHaveLength(0);
    expect(listings).toEqual(['local']);
    expect(result).toMatchObject({ result: { isError: true } });
  });

  it.each(['incognito', 'offline', 'disabled', 'solo'])('blocks discovery for %s chats', async (gate) => {
    const parent = createSession();
    if (gate === 'incognito') parent.incognito = true;
    if (gate === 'offline') parent.offline = true;
    if (gate === 'disabled') parent.disabledTools = ['spawn_agent'];
    if (gate === 'solo') saveSettings({ orchestration: { strategy: 'solo', maxDepth: 2, maxParallel: 4 } });
    saveSession(parent);
    rounds = [[{ type: 'tool_call', call: { id: 'discover', name: 'delegation_targets', input: { provider_id: 'local' } } }, { type: 'done' }]];
    await run(parent, gate === 'offline' ? 'local' : 'frontier');
    expect(listings).toEqual([]);
    expect(children(parent)).toHaveLength(0);
  });

  it('distinguishes an empty chat-model list from an unavailable service', async () => {
    models = [];
    rounds = [[{ type: 'tool_call', call: { id: 'discover', name: 'delegation_targets', input: { provider_id: 'local' } } }, { type: 'done' }]];
    const { result } = await run();
    expect(result).toMatchObject({ result: { output: expect.stringContaining('No chat models available') } });
  });
});

describe('explicit sub-agent routing', () => {
  it('offers optional targets while keeping task required', () => {
    expect(BUILTIN_TOOLS.find((tool) => tool.name === 'spawn_agent')?.parameters).toMatchObject({
      properties: { provider_id: { type: 'string' }, model_id: { type: 'string' } },
      required: ['task'],
    });
  });

  it('inherits provider and exact model without listing or fallback', async () => {
    delegate({ task: 'child task' });
    const { session, result } = await run();
    expect(children(session)).toHaveLength(1);
    expect(children(session)[0]).toMatchObject({ providerId: 'frontier', modelId: 'frontier-exact' });
    expect(requests.map((r) => [r.providerId, r.request.model])).toEqual([
      ['frontier', 'frontier-exact'], ['frontier', 'frontier-exact'], ['frontier', 'frontier-exact'],
    ]);
    expect(listings).toEqual([]);
    expect(result).toMatchObject({ result: { output: 'answer' } });
  });

  it('routes frontier to an explicitly named local model and inherits policy', async () => {
    const parent = createSession();
    parent.mode = 'guardrails';
    parent.disabledTools = ['bash', 'write_file'];
    parent.offline = false;
    parent.incognito = false;
    saveSession(parent);
    delegate({ title: 'Local task', task: 'child task', provider_id: 'local', model_id: 'local-exact' });
    const { result } = await run(parent);
    expect(children(parent)[0]).toMatchObject({ title: 'Local task', providerId: 'local', modelId: 'local-exact', mode: 'guardrails', disabledTools: ['bash', 'write_file'], offline: false, incognito: false });
    expect(listings).toEqual(['local']);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'local', 'frontier']);
    expect(requests[1].request.tools?.some((t) => ['bash', 'write_file'].includes(t.name))).toBe(false);
    expect(result).toMatchObject({ result: { output: 'answer' } });
  });

  it('allows an explicit model on the inherited provider', async () => {
    models = [{ id: 'other-exact', providerId: 'frontier', name: 'Other' }];
    delegate({ task: 'child task', model_id: 'other-exact' });
    const { session } = await run();
    expect(children(session)[0]).toMatchObject({ providerId: 'frontier', modelId: 'other-exact' });
    expect(listings).toEqual(['frontier']);
  });

  it.each([
    { task: 'child', provider_id: 'unknown', model_id: 'local-exact' },
    { task: 'child', provider_id: 'disabled', model_id: 'local-exact' },
    { task: 'child', provider_id: 'local' },
    { task: 'child', provider_id: '' },
    { task: 'child', provider_id: '  ' },
    { task: 'child', provider_id: 123 },
    { task: 'child', model_id: '' },
    { task: 'child', model_id: '  ' },
    { task: 'child', model_id: null },
    { task: 'child', model_id: 123 },
    { task: '' },
    { task: {} },
    {},
    null,
  ])('rejects malformed or unconfigured targets before creating a child: %j', async (input) => {
    delegate(input);
    const { session, result } = await run();
    expect(result).toMatchObject({ result: { isError: true } });
    expect(children(session)).toEqual([]);
    expect(listings).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('tells the model to omit blank routing IDs to inherit the parent route', async () => {
    delegate({ task: 'child', provider_id: '', model_id: '' });
    const { session, result } = await run();
    expect(result).toMatchObject({ result: { isError: true, output: expect.stringMatching(/omit provider_id and model_id entirely/) } });
    expect(children(session)).toEqual([]);
  });

  it.each(['absent', 'nonchat', 'unavailable'])('rejects %s explicit models before creating a child', async (failure) => {
    if (failure === 'absent') models = [];
    if (failure === 'nonchat') models = [{ id: 'text-embedding-3-small', name: 'Embedding', providerId: 'local' }];
    if (failure === 'unavailable') listingError = true;
    delegate({ task: 'child', provider_id: 'local', model_id: failure === 'nonchat' ? 'text-embedding-3-small' : 'local-exact' });
    const { session, result } = await run();
    expect(result).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('https://private.example');
    expect(children(session)).toEqual([]);
    expect(listings).toEqual(['local']);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'frontier']);
  });

  it.each(['whisper-large-v3', 'bge-m3', 'parakeet-unified-en-0.6b', 'stable-diffusion-xl', 'unlimited-ocr'])('rejects known non-chat model %s without falling back to the unfiltered list', async (modelId) => {
    models = [{ id: modelId, providerId: 'local', name: modelId }];
    delegate({ task: 'child', provider_id: 'local', model_id: modelId });
    const { session, result } = await run();
    expect(result).toMatchObject({ result: { isError: true, output: expect.stringMatching(/not a chat model/) } });
    expect(children(session)).toEqual([]);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'frontier']);
  });

  it('returns child model failures as tool errors without retrying another model or provider', async () => {
    delegate({ task: 'child', provider_id: 'local', model_id: 'local-exact' });
    rounds.push(new Error('model unavailable'));
    const { result } = await run();
    expect(result).toMatchObject({ result: { isError: true } });
    expect(requests.map((r) => [r.providerId, r.request.model])).toEqual([
      ['frontier', 'frontier-exact'], ['local', 'local-exact'], ['frontier', 'frontier-exact'],
    ]);
  });

  it('exposes only enabled provider IDs and labels and requires known exact models', async () => {
    await run();
    const system = requests[0].request.system!;
    expect(system).toContain('frontier');
    expect(system).toContain('Local worker');
    expect(system).not.toContain('Disabled worker');
    expect(system).not.toContain('private-token');
    expect(system).not.toContain('https://private.example');
    expect(system).toMatch(/exact model/i);
    expect(system).toMatch(/never guess/i);
    expect(listings).toEqual([]);
  });

  it('inherits the effective default mode and enforces disabled tools even if the child requests one', async () => {
    const parent = createSession();
    parent.disabledTools = ['bash'];
    saveSession(parent);
    delegate({ task: 'child', provider_id: 'local', model_id: 'local-exact' });
    rounds.push([{ type: 'tool_call', call: { id: 'blocked', name: 'bash', input: { command: 'must-not-run' } } }, { type: 'done' }]);
    const { events } = await run(parent);
    expect(children(parent)[0]).toMatchObject({ mode: 'yolo', disabledTools: ['bash'] });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', result: expect.objectContaining({ toolCallId: 'blocked', isError: true, output: expect.stringMatching(/disabled/) }) }));
  });

  it('rejects an invalid provider endpoint before listing models or creating a child', async () => {
    providers[1].baseUrl = 'file:///tmp/model';
    saveSettings({ providers });
    delegate({ task: 'child', provider_id: 'local', model_id: 'local-exact' });
    const { session, result } = await run();
    expect(result).toMatchObject({ result: { isError: true } });
    expect(children(session)).toEqual([]);
    expect(listings).toEqual([]);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'frontier']);
  });

  it('does not delegate when spawn_agent is disabled even if the model calls it', async () => {
    const parent = createSession();
    parent.disabledTools = ['spawn_agent'];
    saveSession(parent);
    delegate({ task: 'child' });
    const { result } = await run(parent);
    expect(result).toMatchObject({ result: { isError: true } });
    expect(children(parent)).toEqual([]);
    expect(requests[0].request.tools?.some((t) => t.name === 'spawn_agent')).toBe(false);
    expect(requests[0].request.system).not.toContain('enabled configured providers');
  });

  it('requires approval before delegation in ask mode', async () => {
    saveSettings({ providers, workspaces: [], defaultChatMode: 'ask' });
    const parent = createSession();
    delegate({ task: 'child' });
    const events: AgentEvent[] = [];
    await sendChat({ sessionId: parent.id, providerId: 'frontier', modelId: 'frontier-exact', text: 'delegate this' }, (event) => {
      events.push(event);
      if (event.type === 'tool_approval_required') resolveApproval(event.sessionId, event.call.id, false);
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_approval_required', call: expect.objectContaining({ name: 'spawn_agent' }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', result: expect.objectContaining({ isError: true, output: expect.stringMatching(/not approved/i) }) }));
    expect(children(parent)).toEqual([]);
  });

  it('requires approval before calling an MCP tool in ask mode', async () => {
    saveSettings({ providers, workspaces: [], defaultChatMode: 'ask' });
    mcpToolSpecs.mockReturnValue([{ name: 'mcp__server__mutate', description: 'Mutate', parameters: { type: 'object', properties: {} } }]);
    rounds = [[{ type: 'tool_call', call: { id: 'mcp1', name: 'mcp__server__mutate', input: {} } }, { type: 'done' }]];
    const session = createSession();
    const events: AgentEvent[] = [];
    await sendChat({ sessionId: session.id, providerId: 'frontier', modelId: 'frontier-exact', text: 'use MCP' }, (event) => {
      events.push(event);
      if (event.type === 'tool_approval_required') resolveApproval(event.sessionId, event.call.id, false);
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_approval_required', call: expect.objectContaining({ name: 'mcp__server__mutate' }) }));
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('blocks incognito delegation without creating or persisting child content', async () => {
    const parent = createSession();
    parent.incognito = true;
    saveSession(parent);
    const before = getSession(parent.id);
    delegate({ task: 'private child', provider_id: 'local', model_id: 'local-exact' });
    const { result } = await run(parent);
    expect(result).toMatchObject({ result: { isError: true, output: expect.stringMatching(/incognito/i) } });
    expect(listSessions()).toEqual([before]);
    expect(listings).toEqual([]);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'frontier']);
  });
});

describe('reply suggestions', () => {
  const replied = () => {
    const session = createSession();
    session.providerId = 'frontier';
    session.modelId = 'frontier-exact';
    session.messages = [
      { id: 'u1', role: 'user', content: 'add a test for the parser', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'Added chat.test.ts with the new cases.', createdAt: 2 },
    ];
    saveSession(session);
    return session;
  };

  it('suggests from the reply on its own provider and model, out of band', async () => {
    const session = replied();
    const out = await suggestReplies(session.id);
    expect(out).toEqual({ options: ['Run the tests', 'Explain the diff'], next: 'Run the new tests' });
    expect(suggestRequests).toHaveLength(1);
    expect(suggestRequests[0].providerId).toBe('frontier');
    expect(suggestRequests[0].request.model).toBe('frontier-exact');
    expect(suggestRequests[0].request.purpose).toBe('suggest');
    expect(suggestRequests[0].request.messages.at(-1)?.content).toContain('Added chat.test.ts');
    // Sideband traffic stays out of the turn buckets.
    expect(requests).toEqual([]);
  });

  it('checks bounded past user replies even when assistant messages fill the recent tail', async () => {
    const session = replied();
    session.messages = [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `user-${i}`, role: 'user' as const,
        content: `Preference ${i}: ${'x'.repeat(900)}`, createdAt: i,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `assistant-${i}`, role: 'assistant' as const,
        content: `Progress ${i}`, createdAt: 10 + i,
      })),
    ];
    saveSession(session);
    await suggestReplies(session.id);
    const prompt = suggestRequests[0].request.messages.at(-1)?.content ?? '';
    expect(prompt).toContain('Past user replies (oldest first):');
    expect(prompt).toContain('Preference 2:');
    expect(prompt).toContain('Preference 9:');
    expect(prompt).not.toContain('Preference 1:');
    expect(prompt).not.toContain('x'.repeat(801));
    expect(prompt).toContain('already answered, rejected');
    expect(prompt).toContain('{"options":[],"next":"..."}');
    expect(prompt.split('Recent conversation:')[1]).not.toContain('Preference');
  });

  it('returns null when there is no reply to suggest from', async () => {
    const session = createSession();
    session.providerId = 'frontier';
    session.modelId = 'frontier-exact';
    session.messages = [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1 }];
    saveSession(session);
    expect(await suggestReplies(session.id)).toBeNull();
    expect(await suggestReplies('missing-session')).toBeNull();
    expect(suggestRequests).toEqual([]);
  });

  it('skips sessions with nobody at the composer to click a chip', async () => {
    for (const flag of ['taskId', 'trainingRunId', 'parentSessionId'] as const) {
      const session = replied();
      session[flag] = 'x1';
      saveSession(session);
      expect(await suggestReplies(session.id)).toBeNull();
    }
    expect(suggestRequests).toEqual([]);
  });

  it('turns a provider failure into no suggestions rather than an error', async () => {
    const session = replied();
    suggestError = new Error('provider down');
    expect(await suggestReplies(session.id)).toBeNull();
  });

  it('respects the offline gate for remote providers', async () => {
    providers[1].baseUrl = 'https://remote.example/v1';
    saveSettings({ providers });
    const session = replied();
    session.providerId = 'local';
    session.modelId = 'local-exact';
    session.offline = true;
    saveSession(session);
    expect(await suggestReplies(session.id)).toBeNull();
    expect(suggestRequests).toEqual([]);
  });
});

describe('prompt part fills', () => {
  const drafting = () => {
    const session = createSession();
    session.providerId = 'frontier';
    session.modelId = 'frontier-exact';
    saveSession(session);
    return session;
  };

  it('drafts the missing part on the session provider and model, out of band', async () => {
    const session = drafting();
    const out = await fillPromptPart(session.id, 'Role', 'review my parser for edge cases');
    expect(out).toBe('You are a senior reviewer for this codebase.');
    expect(fillRequests).toHaveLength(1);
    expect(fillRequests[0].providerId).toBe('frontier');
    expect(fillRequests[0].request.model).toBe('frontier-exact');
    expect(fillRequests[0].request.purpose).toBe('fill');
    expect(fillRequests[0].request.messages.at(-1)?.content).toContain('review my parser for edge cases');
    expect(fillRequests[0].request.messages.at(-1)?.content).toContain('"Role"');
    expect(requests).toEqual([]);
  });

  it('returns null for missing sessions and sessions with no usable provider', async () => {
    expect(await fillPromptPart('missing-session', 'Role', 'draft')).toBeNull();
    const session = drafting();
    session.providerId = 'disabled';
    saveSession(session);
    expect(await fillPromptPart(session.id, 'Role', 'draft')).toBeNull();
    expect(fillRequests).toEqual([]);
  });

  it('turns a provider failure into null so the deterministic snippet fills', async () => {
    const session = drafting();
    fillError = new Error('provider down');
    expect(await fillPromptPart(session.id, 'Role', 'draft')).toBeNull();
  });

  it('respects the offline gate for remote providers', async () => {
    providers[1].baseUrl = 'https://remote.example/v1';
    saveSettings({ providers });
    const session = drafting();
    session.providerId = 'local';
    session.modelId = 'local-exact';
    session.offline = true;
    saveSession(session);
    expect(await fillPromptPart(session.id, 'Role', 'draft')).toBeNull();
    expect(fillRequests).toEqual([]);
  });
});

describe('offline routing', () => {
  it.each([
    ['openai-compat', 'https://remote.example/v1'],
    ['ollama', 'http://192.168.1.2:11434'],
    ['lmstudio', 'http://localhost.remote.example/v1'],
    ['vllm', 'file:///tmp/model'],
    ['openai-compat', 'not a url'],
    ['openai-compat', 'http://localhost@remote.example/v1'],
    ['anthropic', 'http://localhost:1234'],
    ['openai', 'http://127.0.0.1:1234'],
    ['openrouter', 'http://[::1]:1234'],
  ])('blocks %s at %s before any provider or connector call', async (kind, baseUrl) => {
    providers[1] = { ...providers[1], kind: kind as ProviderConfig['kind'], baseUrl };
    saveSettings({ providers, connectors: [{ kind: 'github', connected: true, token: 'token' }], mcpServers: [{ id: 'm', name: 'MCP', enabled: true, command: 'unused', args: [] }] });
    const session = createSession();
    session.offline = true;
    saveSession(session);
    const { events } = await run(session, 'local', 'local-exact');
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringMatching(/offline/i) }));
    expect(requests).toEqual([]);
    expect(listings).toEqual([]);
    expect(syncMcp).not.toHaveBeenCalled();
    expect(connectorFetch).not.toHaveBeenCalled();
    expect(getSession(session.id)?.messages).toEqual([]);
  });

  it.each(['http://127.0.0.1:1234/v1', 'https://localhost:1234/v1', 'http://[::1]:1234/v1'])('allows local offline chat at %s with local tools only and no hidden spec calls', async (baseUrl) => {
    providers[1].baseUrl = baseUrl;
    saveSettings({ providers });
    const session = createSession();
    session.offline = true;
    session.specLinked = true;
    saveSession(session);
    const { events } = await run(session, 'local', 'local-exact');
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(requests).toHaveLength(1);
    const offered = (requests[0].request.tools ?? []).map((t: { name: string }) => t.name);
    // Local tools stay; anything that reaches a network is gone.
    expect(offered).toEqual(expect.arrayContaining(['read_file', 'write_file', 'grep', 'bash']));
    for (const online of ['fetch_url', 'browser', 'spawn_agent', 'delegation_targets', 'agent_watch', 'decide']) expect(offered).not.toContain(online);
    expect(offered.some((n: string) => n.startsWith('mcp__'))).toBe(false);
    expect(buildSpec).not.toHaveBeenCalled();
    expect(connectorFetch).not.toHaveBeenCalled();
    expect(syncMcp).not.toHaveBeenCalled();
  });

  it('blocks delegation in offline chat even if a model emits the call', async () => {
    const session = createSession();
    session.offline = true;
    saveSession(session);
    delegate({ task: 'child', provider_id: 'frontier', model_id: 'frontier-exact' });
    const { result } = await run(session, 'local', 'local-exact');
    expect(result).toMatchObject({ result: { isError: true } });
    expect(children(session)).toEqual([]);
    expect(listings).toEqual([]);
    expect(requests.map((r) => r.providerId)).toEqual(['local', 'local']);
    expect(requests.every((r) => !(r.request.tools ?? []).some((t: { name: string }) => t.name === 'spawn_agent'))).toBe(true);
  });

  it('rejects disabled providers for ordinary chat before model calls', async () => {
    const { events } = await run(createSession(), 'disabled', 'model');
    expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(requests).toEqual([]);
  });
});

describe('session titles', () => {
  /** titleSession runs fire-and-forget after the turn; drain microtasks. */
  async function settle() {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  }

  it('writes a real title from the first turn, marked as sideband traffic', async () => {
    const session = createSession();
    await run(session);
    await settle();
    expect(titleRequests).toHaveLength(1);
    expect(titleRequests[0].request.messages[0].content).toContain('delegate this');
    expect(getSession(session.id)?.title).toBe('answer');
    expect(getSession(session.id)?.titleAuto).toBe(false);

    // A second turn does not regenerate: generation is a first-turn thing.
    await sendChat({ sessionId: session.id, providerId: 'frontier', modelId: 'frontier-exact', text: 'more work' }, () => {});
    await settle();
    expect(titleRequests).toHaveLength(1);
    expect(getSession(session.id)?.title).toBe('answer');
  });

  it('leaves a title the user set alone', async () => {
    const session = createSession();
    session.title = 'My chat';
    session.titleAuto = false;
    saveSession(session);
    await run(session);
    await settle();
    expect(titleRequests).toEqual([]);
    expect(getSession(session.id)?.title).toBe('My chat');
  });
});


describe('child checkpoint recovery', () => {
  it('resumes a lost child on the same route without creating a duplicate session', async () => {
    delegate({ task: 'finish the delegated work' });
    rounds.push(new Error('The engine stopped driving this reply.'), [{ type: 'text', delta: 'Recovered child result.' }, { type: 'done' }]);
    const { session, result } = await run();
    expect(children(session)).toHaveLength(1);
    const child = getSession(children(session)[0].id)!;
    expect(child.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(child.messages.at(-1)?.content).toBe('Recovered child result.');
    expect(result?.type === 'tool_result' && result.result.output).toContain('Recovered child result.');
    expect(requests.every(r => r.providerId === 'frontier')).toBe(true);
  });
  it('hands the parent the real failure and child ID when the recovery budget is exhausted', async () => {
    delegate({ task: 'finish the delegated work' });
    rounds.push(new Error('The engine stopped driving this reply.'), new Error('The engine stopped driving this reply.'));
    const { session, result } = await run();
    expect(children(session)).toHaveLength(1);
    expect(result?.type === 'tool_result' && result.result.isError).toBe(true);
    expect(result?.type === 'tool_result' && result.result.output).toContain(children(session)[0].id);
    expect(result?.type === 'tool_result' && result.result.output).toContain('Continue the delegated task directly');
  });
});

describe('tools-off turns', () => {
  it('offers only update_plan and refuses a tool the turn did not offer', async () => {
    const session = createSession();
    session.mode = 'yolo';
    saveSession(session);
    rounds = [[{ type: 'tool_call', call: { id: 'x', name: 'bash', input: { command: 'echo injected' } } }, { type: 'done' }]];
    const events: AgentEvent[] = [];
    await sendChat({ sessionId: session.id, providerId: 'frontier', modelId: 'frontier-exact', text: 'summarize', noTools: true }, (event) => events.push(event));
    expect(requests[0].request.tools?.map((t) => t.name)).toEqual(['update_plan']);
    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ result: { isError: true, output: expect.stringContaining('disabled or unavailable') } });
  });
});

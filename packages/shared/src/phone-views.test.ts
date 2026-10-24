import { describe, expect, it } from 'vitest';
import { callFromPhone, checkPhoneAccess, PHONE_ALWAYS_DENIED, PHONE_CHANNELS, phoneChannelAllowed, phoneChannelClass } from './phone-access.js';
import { PHONE_MONITOR_SOURCES, PHONE_MONITOR_VIEW, PHONE_VIEWS, phoneMonitorView } from './phone-views.js';

/** A computer with secrets in every record the new phone views read. */
const SECRET = /secret|sk-|tok:|\/Users\/|C:\\\\|workspaceId|providerId|modelId|prompt"|condition|steps"|triggers|command|account|token|creditsBalance|byProvider|bySession|avoided|headRefName|owner/;

const host: Record<string, unknown> = {
  'settings:get': {
    theme: 'dark',
    automationsPaused: true,
    prompts: [{ id: 'fix', name: 'fix', body: 'Find the bug.', author: '/Users/me', secret: 1 }, { name: 'no body' }, null],
    providers: [{ id: 'claude', kind: 'anthropic', auth: 'subscription', tokenKey: 'tok:secret', apiKey: 'sk-secret' }],
  },
  'providers:list': [{ id: 'claude', kind: 'anthropic', auth: 'subscription', tokenKey: 'tok:secret' }],
  'tasks:list': [{ id: 't', title: 'Nightly', kind: 'recurring', prompt: 'secret instruction', workspaceId: 'w', providerId: 'p', modelId: 'm', condition: 'secret', status: 'active', runCount: 1, createdAt: 1, lastResult: 'x'.repeat(PHONE_VIEWS.textChars + 10) }],
  'workflows:list': { workflows: [{ id: 'w', name: 'Deploy', category: 'Ops', enabled: true, steps: [{ command: 'secret.sh' }], triggers: [{ token: 'secret' }], workspaceId: 'w', createdAt: 1, updatedAt: 1 }], runs: [{ steps: [{ output: 'secret' }] }] },
  'workflow:run': { id: 'r', workflowId: 'w', status: 'running', startedAt: 1, steps: [{ output: 'secret' }], message: 'secret' },
  'pr:sessionList': [{ url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1, title: 'T', state: 'open', isDraft: false, checks: 'pending', headRefName: 'secret-branch', source: 'gh' }],
  'usage:summary': { totalInput: 1, totalOutput: 2, totalCost: 0.5, byModel: { '/Users/me/models/local.gguf': { input: 1, output: 2 } }, byProvider: { secret: {} }, bySession: { s: {} }, bySessionCost: {}, daily: [], avoidedCosts: {} },
  'limits:get': { windows: [{ id: 'w', label: 'Week', scope: 'weekly', usedPercent: 10, resetAt: 1, status: 'allowed', token: 'secret' }], planType: 'pro', creditsBalance: 9, updatedAt: 1, staleAfterMs: 1, account: 'secret' },
  'chat:editQueued': { id: 's', workspaceId: 'w', messages: [{ content: 'secret transcript' }], queue: ['a', { text: 'b', images: ['data:image/jpeg;base64,secret'] }] },
  'session:fork': { id: 's2', title: 'New chat', workspaceId: 'w', messages: [{ content: 'secret transcript' }] },
};
const dispatch = (channel: string) => host[channel];

describe('the phone views beyond the chat', () => {
  it('send nothing past their field lists', async () => {
    const calls: Array<[string, unknown[]]> = [
      ['settings:get', []],
      ['tasks:list', []],
      ['workflows:list', []],
      ['workflow:run', ['w']],
      ['pr:sessionList', ['s']],
      ['usage:summary', []],
      ['limits:get', ['claude']],
      ['chat:editQueued', ['s', 0, { expect: 'a', text: 'c' }]],
      ['session:fork', ['s', 'm1']],
      ['task:runNow', ['t']],
    ];
    for (const [channel, args] of calls) {
      const view = await callFromPhone(dispatch, channel, args);
      expect(JSON.stringify(view) ?? 'null', channel).not.toMatch(SECRET);
    }
  });

  it('cut long text and keep only well-formed saved prompts', async () => {
    const tasks = (await callFromPhone(dispatch, 'tasks:list', [])) as Array<{ lastResult: string }>;
    expect(tasks[0].lastResult).toHaveLength(PHONE_VIEWS.textChars);
    const settings = (await callFromPhone(dispatch, 'settings:get', [])) as { prompts: unknown[]; automationsPaused: boolean };
    expect(settings.prompts).toEqual([{ id: 'fix', name: 'fix', body: 'Find the bug.' }]);
    expect(settings.automationsPaused).toBe(true);
  });

  it('read limits by provider id, never with a key the phone sent', async () => {
    const seen: unknown[][] = [];
    const record = (channel: string, args: unknown[]) => {
      seen.push([channel, args]);
      return dispatch(channel);
    };
    await callFromPhone(record, 'limits:get', ['claude', true]);
    expect(seen).toEqual([['providers:list', []], ['limits:get', ['tok:secret', false]]]);
    seen.length = 0;
    expect(await callFromPhone(record, 'limits:get', ['tok:secret'])).toBeNull();
    expect(seen).toEqual([['providers:list', []]]);
  });

  it('keep files, terminal commands, the browser, stack calls and automation editing off the phone', () => {
    // Git opened with IO-33 FA-2 (phone-git.test.ts); the stack calls did not.
    for (const channel of [
      'pr:continueStack', 'pr:linkStack', 'file:read', 'file:write', 'dir:list',
      'terminal:run', 'shell:openPath', 'task:create', 'task:update', 'task:delete', 'workflow:create',
      'workflow:update', 'workflow:delete', 'workflow:cancel', 'workflow:event', 'changes:accept',
    ]) {
      expect(phoneChannelAllowed(channel), channel).toBe(false);
    }
    for (const c of PHONE_CHANNELS) expect((PHONE_ALWAYS_DENIED.channels as string[]).includes(c), c).toBe(false);
  });
});

describe('the Monitors pane (monitor:summary)', () => {
  const sources: Record<string, unknown> = {
    'system:stats': { cpuPct: 42.5, cpuCores: 16, cpuModel: 'AMD Ryzen 9 7950X', memUsedMB: 20000, memTotalMB: 65536, temps: { cpuC: 71, memoryC: 48 } },
    'gpu:stats': {
      source: 'nvidia-smi',
      devices: [
        { name: 'NVIDIA GeForce RTX 4090', memoryTotalMB: 24564, memoryUsedMB: 9000, utilizationPct: 87, temperatureC: 66 },
        { name: 'NVIDIA GeForce RTX 3060', memoryTotalMB: 12288, memoryUsedMB: 100, utilizationPct: 3, temperatureC: 70 },
      ],
      totalMB: 36852,
      usedMB: 9100,
      freeMB: 27752,
    },
    'chat:running': ['a', 'b', 'a', 'gone'],
    'sessions:summaries': [
      { id: 'a', title: 'Fix the build', workspaceId: '/Users/me/secret', activeRun: { startedAt: 1_000 }, firstUserText: 'secret prompt' },
      { id: 'b', title: 'T'.repeat(500), activeRun: { startedAt: 9_000 } },
      { id: 'c', title: 'Idle' },
    ],
    'chat:pending': {
      a: { sessionId: 'a', approval: { call: { id: 'call-1', name: 'bash', input: { command: 'rm -rf /Users/me/secret' } }, reason: 'secret reason', severity: 'high', requestedAt: 500 } },
      c: { sessionId: 'c', question: { callId: 'q-1', askedAt: 300, questions: [{ id: 'x', header: 'Auth', question: 'Which auth method?', options: [{ label: 'secret option' }] }] } },
    },
    'tasks:list': [
      { id: 't1', title: 'Nightly', status: 'active', nextRunAt: 50_000, prompt: 'secret instruction', workspaceId: 'w' },
      { id: 't2', title: 'Paused', status: 'paused', nextRunAt: 10 },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: `R${i}`, status: 'active', nextRunAt: 60_000 + i })),
    ],
    'workflows:list': { workflows: [{ id: 'w1', name: 'Deploy', enabled: true, nextRunAt: 20_000, steps: [{ command: 'secret.sh' }] }, { id: 'w2', name: 'Off', enabled: false, nextRunAt: 1 }] },
  };
  const ask = (s: Record<string, unknown>) => (channel: string) => s[channel];

  it('reads the computer’s own sources and screens them', async () => {
    const seen: string[] = [];
    const view = (await callFromPhone((c, a) => (seen.push(c), expect(a).toEqual([]), ask(sources)(c)), 'monitor:summary', [{ deep: true }])) as Record<string, unknown>;
    expect(seen).toEqual([...PHONE_MONITOR_SOURCES]);
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/secret|Ryzen|RTX|NVIDIA|rm -rf|\/Users\//);
    expect(view.hardware).toEqual({
      cpu: { loadPct: 42.5, cores: 16, tempC: 71 },
      memory: { usedMB: 20000, totalMB: 65536, tempC: 48 },
      gpu: { memoryUsedMB: 9100, memoryTotalMB: 36852, loadPct: 87, tempC: 70 },
    });
  });

  it('lists running chats, what waits on you and the next automations, capped', () => {
    const view = phoneMonitorView(sources, 10_000);
    expect(view.running).toEqual([
      { id: 'a', title: 'Fix the build', step: 'approval', elapsedMs: 9_000 },
      { id: 'b', title: 'T'.repeat(PHONE_MONITOR_VIEW.labelChars), step: 'working', elapsedMs: 1_000 },
      { id: 'gone', title: '', step: 'working' },
    ]);
    expect(view.needsYou).toEqual([
      { sessionId: 'c', title: 'Idle', kind: 'question', callId: 'q-1', label: 'Which auth method?', count: 1, since: 300 },
      { sessionId: 'a', title: 'Fix the build', kind: 'approval', callId: 'call-1', risk: 'high', label: 'bash', since: 500 },
    ]);
    const autos = view.automations as Array<{ id: string }>;
    expect(autos).toHaveLength(PHONE_MONITOR_VIEW.automations);
    expect(autos.slice(0, 3)).toEqual([
      { kind: 'workflow', id: 'w1', name: 'Deploy', nextRunAt: 20_000 },
      { kind: 'task', id: 't1', name: 'Nightly', nextRunAt: 50_000 },
      { kind: 'task', id: 'r0', name: 'R0', nextRunAt: 60_000 },
    ]);
    // A start the computer's clock has not reached reads as 0, never negative.
    expect((phoneMonitorView(sources, 0).running as Array<{ elapsedMs?: number }>)[0].elapsedMs).toBe(0);
  });

  it('answers with empty rows when the computer has nothing to say', () => {
    expect(phoneMonitorView({}, 0)).toEqual({
      hardware: { cpu: { loadPct: 0, cores: 0 }, memory: { usedMB: 0, totalMB: 0 }, gpu: null },
      running: [],
      needsYou: [],
      automations: [],
    });
    expect((phoneMonitorView({ 'system:stats': { temps: { gpuC: 55 } } }, 0).hardware as { gpu: unknown }).gpu).toEqual({ tempC: 55 });
  });

  it('is a read: refused with Read off', () => {
    expect(phoneChannelClass('monitor:summary')).toBe('read');
    expect(() => checkPhoneAccess('monitor:summary', { read: false, change: true })).toThrow(/read-off/);
  });
});

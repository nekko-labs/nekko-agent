import { describe, expect, it } from 'vitest';
import { callFromPhone, PHONE_ALWAYS_DENIED, PHONE_CHANNELS, phoneChannelAllowed } from './phone-access.js';
import { PHONE_VIEWS } from './phone-views.js';

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

  it('keep git, files, terminal commands, the browser and automation editing off the phone', () => {
    for (const channel of [
      'pr:action', 'pr:diff', 'pr:continueStack', 'workspace:gitStatus', 'file:read', 'file:write', 'dir:list',
      'terminal:run', 'shell:openPath', 'task:create', 'task:update', 'task:delete', 'workflow:create',
      'workflow:update', 'workflow:delete', 'workflow:cancel', 'workflow:event', 'changes:accept',
    ]) {
      expect(phoneChannelAllowed(channel), channel).toBe(false);
    }
    for (const c of PHONE_CHANNELS) expect((PHONE_ALWAYS_DENIED.channels as string[]).includes(c), c).toBe(false);
  });
});

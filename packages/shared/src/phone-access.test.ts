import { describe, expect, it, vi } from 'vitest';
import { IpcChannels } from './ipc.js';
import {
  PHONE_ALWAYS_DENIED,
  PHONE_CHANNELS,
  PHONE_SETTINGS_KEYS,
  PHONE_SETTINGS_VIEW,
  PhoneAccessError,
  callFromPhone,
  phoneAlwaysDenied,
  phoneChannelAllowed,
  phoneSettingsUpdate,
  redactPhoneResult,
  phoneSessionView,
  PHONE_SESSION_VIEW,
  screenPhoneCall,
} from './phone-access.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PhoneAccessError);
    return (e as PhoneAccessError).code;
  }
  return 'ok';
};

/** A full settings object with every kind of secret the computer holds. */
const SETTINGS = {
  theme: 'dark',
  phoneChanges: true,
  accent: '#6d5efc',
  accent2: '#22d3ee',
  themePreset: 'nebula',
  defaultProviderId: 'p1',
  defaultModelId: 'm1',
  favoriteModels: ['p1::m1'],
  defaultChatMode: 'ask',
  chatPaneAction: 'complete',
  skipDeleteConfirmation: false,
  sandboxMode: 'workspace',
  providers: [{ id: 'p1', kind: 'anthropic', label: 'Claude', baseUrl: 'https://x', apiKey: 'sk-secret', tokenKey: 'tk', enabled: true }],
  guardrails: [{ id: 'g', pattern: 'rm -rf' }],
  workspaces: [{ id: 'w', path: '/home/me/secret-project' }],
  connectors: [{ id: 'c', token: 'ghp_secret' }],
  hfToken: 'hf_secret',
  typesafeApiKey: 'ts_secret',
  engine: { apiKey: 'engine-secret' },
  apiServer: { token: 'api-secret' },
  messaging: { telegram: { botToken: 'bot-secret' } },
  mcpServers: [{ id: 'm', env: { TOKEN: 'mcp-secret' } }],
  hooks: [{ id: 'h', command: 'curl evil' }],
  systemInstructions: 'private',
  aboutUser: 'private',
  voice: { enabled: true, language: 'en', modelPath: '/models/w.bin', runtimePath: '/bin/whisper', deviceId: 'mic' },
};

describe('phone channel allowlist', () => {
  it('names only real channels, and none the always-denied list forces off', () => {
    const all = new Set<string>(Object.values(IpcChannels));
    for (const c of PHONE_CHANNELS) {
      expect(all.has(c), c).toBe(true);
      expect(phoneAlwaysDenied(c), c).toBe(false);
    }
    for (const c of PHONE_ALWAYS_DENIED.channels) expect(all.has(c), c).toBe(true);
  });

  it('refuses the dangerous channels and anything unlisted', () => {
    for (const c of [
      'data:wipe', 'settings:reset', 'remote:revoke', 'remote:rotate', 'remote:enable', 'remote:pair',
      'terminal:create', 'terminal:write', 'terminals:list', 'file:write', 'workspace:addByPath',
      'workspace:remove', 'voice:install', 'voice:uninstall', 'connector:connect', 'connector:disconnect',
      'mcp:status', 'mcp:hypergate:connect', 'providers:save', 'oauth:begin', 'file:read', 'task:create',
      'turn:pending', 'no:such',
    ]) {
      expect(phoneChannelAllowed(c), c).toBe(false);
      expect(code(() => screenPhoneCall(c, [])), c).toBe('channel-denied');
    }
    expect(phoneAlwaysDenied('remote:status')).toBe(false);
  });
});

describe('settings from a phone', () => {
  it('accepts only the listed keys with valid values', () => {
    expect(code(() => screenPhoneCall('settings:update', [{ defaultChatMode: 'guardrails', chatPaneAction: 'delete' }]))).toBe('ok');
    expect(code(() => screenPhoneCall('settings:update', [{ voice: { enabled: false, language: 'es' } }]))).toBe('ok');
    expect(code(() => screenPhoneCall('settings:update', [{ sandboxMode: 'off' }]))).toBe('setting-denied');
    expect(code(() => screenPhoneCall('settings:update', [{ guardrails: [] }]))).toBe('setting-denied');
    expect(code(() => screenPhoneCall('settings:update', [{ voice: { modelPath: '/tmp/x' } }]))).toBe('setting-denied');
    expect(code(() => screenPhoneCall('settings:update', [{ voice: null }]))).toBe('setting-denied');
    expect(code(() => screenPhoneCall('settings:update', [{ chatPaneAction: 'explode' }]))).toBe('value-invalid');
    expect(code(() => screenPhoneCall('settings:update', [{ voice: { language: '../../x' } }]))).toBe('value-invalid');
    expect(code(() => screenPhoneCall('settings:update', [null]))).toBe('value-invalid');
    expect(code(() => screenPhoneCall('settings:update', [[]]))).toBe('value-invalid');
  });

  it('allows YOLO as the default chat mode, and for one chat', () => {
    expect(code(() => screenPhoneCall('settings:update', [{ defaultChatMode: 'yolo' }]))).toBe('ok');
    expect(code(() => screenPhoneCall('session:setOptions', ['s1', { mode: 'yolo' }]))).toBe('ok');
    expect(code(() => screenPhoneCall('session:setOptions', ['s1', { mode: 'ask' }]))).toBe('ok');
    expect(code(() => screenPhoneCall('session:setOptions', ['s1', { mode: 'turbo' }]))).toBe('value-invalid');
  });

  it('applies nothing when one key of the patch is refused', async () => {
    const dispatch = vi.fn(() => SETTINGS);
    await expect(callFromPhone(dispatch, 'settings:update', [{ chatPaneAction: 'delete', sandboxMode: 'off' }])).rejects.toThrow(PhoneAccessError);
    await expect(callFromPhone(dispatch, 'settings:update', [{ chatPaneAction: 'delete', defaultChatMode: 'turbo' }])).rejects.toThrow(/value-invalid/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps the rest of voice when a phone changes one voice field', async () => {
    const calls: unknown[][] = [];
    const dispatch = (channel: string, args: unknown[]) => {
      calls.push([channel, args]);
      return SETTINGS;
    };
    await callFromPhone(dispatch, 'settings:update', [{ voice: { language: 'it' } }]);
    expect(calls[1]).toEqual(['settings:update', [{ voice: { ...SETTINGS.voice, language: 'it' } }]]);
  });

  it('never writes a key that is not phone-settable, even when handed one', () => {
    const patch = phoneSettingsUpdate([['__proto__.polluted', true], ['sandboxMode', 'off'], ['chatPaneAction', 'delete']], {});
    expect(patch).toEqual({ chatPaneAction: 'delete' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns a view with no secrets, for get and update alike', async () => {
    for (const channel of ['settings:get', 'settings:update']) {
      const args = channel === 'settings:update' ? [{ skipDeleteConfirmation: true }] : [];
      const view = (await callFromPhone(() => SETTINGS, channel, args)) as Record<string, unknown>;
      const text = JSON.stringify(view);
      expect(text).not.toMatch(/secret|sk-|hf_|ghp_|tokenKey|apiKey|providers|guardrails|workspaces|hooks|modelPath|private/);
      expect(Object.keys(view).sort()).toEqual([...new Set(PHONE_SETTINGS_VIEW.map((p) => p.split('.')[0]))].sort());
      expect(view.voice).toEqual({ enabled: true, language: 'en' });
      expect(view.defaultModelId).toBe('m1');
    }
    for (const key of PHONE_SETTINGS_KEYS) expect(PHONE_SETTINGS_VIEW as readonly string[]).toContain(key);
  });

  it('strips provider records to id, kind, label and enabled', () => {
    expect(redactPhoneResult('providers:list', SETTINGS.providers)).toEqual([{ id: 'p1', kind: 'anthropic', label: 'Claude', enabled: true }]);
    expect(redactPhoneResult('providers:list', null)).toEqual([]);
  });
});

describe('chat options from a phone', () => {
  it('allows the model, completing and organising, not tools or isolation', () => {
    expect(code(() => screenPhoneCall('session:setOptions', ['s1', { providerId: 'p', modelId: 'm' }]))).toBe('ok');
    expect(code(() => screenPhoneCall('session:setOptions', ['s1', { archivedAt: 123 }]))).toBe('ok');
    expect(code(() => screenPhoneCall('session:setOptions', ['s1', { disabledTools: [] }]))).toBe('option-denied');
    expect(code(() => screenPhoneCall('session:setOptions', ['s1', { executionMode: 'local' }]))).toBe('option-denied');
    expect(code(() => screenPhoneCall('session:setOptions', ['s1', null]))).toBe('value-invalid');
  });

  it('allows a plain chat:send, not attaching files on the computer', () => {
    expect(code(() => screenPhoneCall('chat:send', [{ sessionId: 's', providerId: 'p', modelId: 'm', text: 'hi' }]))).toBe('ok');
    expect(code(() => screenPhoneCall('chat:send', [{ sessionId: 's', text: 'hi', attachedPaths: ['/etc/passwd'] }]))).toBe('option-denied');
  });

  it('passes an allowed call through unchanged', async () => {
    const dispatch = vi.fn(() => ({ id: 's1' }));
    await expect(callFromPhone(dispatch, 'session:get', ['s1'])).resolves.toEqual({ id: 's1' });
    expect(dispatch).toHaveBeenCalledWith('session:get', ['s1']);
  });
});

describe('skills from a phone', () => {
  const RUNNABLE = [
    { name: 'review', description: 'Review the code', category: 'Code quality', source: 'builtin', template: 'Review this carefully.' },
    { name: 'tidy', description: 'Tidy up', category: 'Imported', source: 'claude', template: 'Use the "tidy" skill below. Its own files are in /Users/me/.claude/skills/tidy.\n\nSteps' },
  ];
  const host = () =>
    vi.fn((channel: string, args: unknown[]) => (channel === 'skills:runnable' ? RUNNABLE : { ok: channel, args }));

  it('lists the skills without templates or folders', async () => {
    const view = (await callFromPhone(host(), 'skills:runnable', [])) as Array<Record<string, unknown>>;
    expect(view).toEqual([
      { name: 'review', description: 'Review the code', category: 'Code quality', source: 'builtin' },
      { name: 'tidy', description: 'Tidy up', category: 'Imported', source: 'claude' },
    ]);
    expect(JSON.stringify(view)).not.toContain('/Users/me');
    expect(redactPhoneResult('skills:runnable', null)).toEqual([]);
  });

  it('expands a skill turn on the computer, replacing what the phone sent as text', async () => {
    const dispatch = host();
    await callFromPhone(dispatch, 'chat:send', [
      { sessionId: 's1', providerId: 'p', modelId: 'm', text: 'ignored', skill: { name: 'review', input: ' this file ' } },
    ]);
    expect(dispatch).toHaveBeenLastCalledWith('chat:send', [
      { sessionId: 's1', providerId: 'p', modelId: 'm', text: 'Review this carefully.\n\nthis file', skill: { name: 'review', input: ' this file ' } },
    ]);
  });

  it('expands a queued skill turn the same way', async () => {
    const dispatch = host();
    await callFromPhone(dispatch, 'chat:queue', ['s1', { text: '', skill: { name: 'tidy', input: '' } }]);
    expect(dispatch).toHaveBeenLastCalledWith('chat:queue', ['s1', { text: RUNNABLE[1].template, skill: { name: 'tidy', input: '' } }]);
    await callFromPhone(dispatch, 'chat:queue', ['s1', 'plain']);
    expect(dispatch).toHaveBeenLastCalledWith('chat:queue', ['s1', 'plain']);
  });

  it('refuses an unknown or malformed skill, and queue fields a phone may not set', async () => {
    const dispatch = host();
    await expect(callFromPhone(dispatch, 'chat:send', [{ sessionId: 's1', text: 'x', skill: { name: 'goal', input: 'x' } }])).rejects.toThrow('skill-unknown');
    expect(dispatch).not.toHaveBeenCalledWith('chat:send', expect.anything());
    expect(code(() => screenPhoneCall('chat:send', [{ sessionId: 's', text: '', skill: 'review' }]))).toBe('value-invalid');
    expect(code(() => screenPhoneCall('chat:send', [{ sessionId: 's', text: '', skill: { name: 'review', input: 1 } }]))).toBe('value-invalid');
    expect(code(() => screenPhoneCall('chat:send', [{ sessionId: 's', text: '', skill: { name: 'review', template: 'x' } }]))).toBe('value-invalid');
    expect(code(() => screenPhoneCall('chat:queue', ['s', { text: 'x', attachedPaths: ['/etc'] }]))).toBe('option-denied');
    expect(code(() => screenPhoneCall('chat:queue', ['s', 5]))).toBe('value-invalid');
  });
});

describe('a chat as a phone receives it (session:get)', () => {
  const msg = (i: number, extra: Record<string, unknown> = {}) => ({ id: `m${i}`, role: 'assistant', content: `reply ${i}`, ...extra });

  it('keeps a small chat whole', () => {
    const s = { id: 's1', title: 'Hi', messages: [msg(1), msg(2)] };
    expect(phoneSessionView(s)).toEqual(s);
  });

  it('sends the newest messages and counts the rest', () => {
    const n = PHONE_SESSION_VIEW.messages;
    const s = { id: 's1', messages: Array.from({ length: n + 25 }, (_, i) => msg(i)) };
    const v = phoneSessionView(s) as { messages: { id: string }[]; omittedMessages: number };
    expect(v.messages).toHaveLength(n);
    expect(v.messages[0].id).toBe('m25');
    expect(v.messages.at(-1)?.id).toBe(`m${n + 24}`);
    expect(v.omittedMessages).toBe(25);
    expect(s.messages).toHaveLength(n + 25); // the computer's copy is untouched
  });

  it('drops tool images and cuts long tool output, saying so', () => {
    const big = 'x'.repeat(PHONE_SESSION_VIEW.textChars + 500);
    const s = {
      id: 's1',
      messages: [
        { id: 't1', role: 'tool', content: '', toolResult: { toolCallId: 'c1', output: big, images: [{ data: 'AAAA' }, { data: 'BBBB' }] } },
        { id: 't2', role: 'tool', content: '', toolResult: { toolCallId: 'c2', output: 'short', images: [] } },
      ],
    };
    const [a, b] = (phoneSessionView(s) as { messages: { toolResult: Record<string, unknown> }[] }).messages;
    expect(a.toolResult).toEqual({
      toolCallId: 'c1',
      output: 'x'.repeat(PHONE_SESSION_VIEW.textChars),
      outputChars: PHONE_SESSION_VIEW.textChars + 500,
      truncated: true,
      omittedImages: 2,
    });
    expect(b.toolResult).toEqual({ toolCallId: 'c2', output: 'short' });
  });

  it('cuts long string tool arguments, keeps the rest', () => {
    const big = 'y'.repeat(PHONE_SESSION_VIEW.textChars + 1);
    const s = { id: 's1', messages: [msg(1, { toolCalls: [{ id: 'c1', name: 'write_file', input: { path: 'a.txt', content: big, mode: 1 } }, { id: 'c2', name: 'bash', input: { command: 'ls' } }] })] };
    const [m] = (phoneSessionView(s) as { messages: { toolCalls: Record<string, unknown>[] }[] }).messages;
    expect(m.toolCalls[0]).toEqual({ id: 'c1', name: 'write_file', input: { path: 'a.txt', content: 'y'.repeat(PHONE_SESSION_VIEW.textChars), mode: 1 }, truncated: true });
    expect(m.toolCalls[1]).toEqual({ id: 'c2', name: 'bash', input: { command: 'ls' } });
  });

  it('never splits an emoji when cutting', () => {
    const n = PHONE_SESSION_VIEW.textChars;
    const out = 'z'.repeat(n - 1) + '😀' + 'tail';
    const s = { id: 's1', messages: [{ id: 't', role: 'tool', content: '', toolResult: { toolCallId: 'c', output: out } }] };
    const r = (phoneSessionView(s) as { messages: { toolResult: { output: string } }[] }).messages[0].toolResult.output;
    expect(r).toBe('z'.repeat(n - 1));
  });

  it('is what callFromPhone returns for session:get; other values pass through', async () => {
    const session = { id: 's1', messages: [{ id: 't', role: 'tool', content: '', toolResult: { toolCallId: 'c', output: 'ok', images: [{ data: 'A' }] } }] };
    await expect(callFromPhone(() => session, 'session:get', ['s1'])).resolves.toEqual({
      id: 's1',
      messages: [{ id: 't', role: 'tool', content: '', toolResult: { toolCallId: 'c', output: 'ok', omittedImages: 1 } }],
    });
    expect(phoneSessionView(null)).toBeNull();
    expect(phoneSessionView({ id: 's1' })).toEqual({ id: 's1' });
  });
});

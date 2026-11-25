import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@nekko-agent/shared';
import { STARTER_MODES } from '@nekko-agent/shared';
import { CODE_MODE_DOCS, ModePanel, ToolApproachPicker, chatModeState, modeButtonLabel, modePanelActions, summaryPartIcon, toolApproachLock } from './ModePanel.js';
import { chatEngine, dropCodeModeOnClaudeAgent } from './codeModeLock.js';

const store = vi.hoisted(() => ({
  providers: undefined as undefined | { id: string; kind: string; name: string }[],
  providersLoaded: true,
  settings: { defaultChatMode: 'guardrails', gitManagement: { mode: 'worktree' }, effort: 'normal', workspaces: [{ id: 'w1', name: 'agent-nekko', path: '/code/agent-nekko', addedAt: 1 }], mcpServers: [] } as Record<string, any>,
  refreshSettings: vi.fn(async () => {}),
  pushToast: vi.fn(),
}));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: typeof store) => unknown) => select(store), { getState: () => store }) }));
const yolo = vi.hoisted(() => ({ allow: vi.fn(async (_current: string | undefined, _next: string) => true) }));
vi.mock('./YoloWarning.js', () => ({ allowModeChange: yolo.allow }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));

const base = { id: 'chat', messages: [], executionMode: 'worktree', gitIsolation: true, workspaceId: 'w1' } as unknown as Session;
const starter = (id: string) => STARTER_MODES.find((m) => m.id === id)!;
let session: Session;
const deps = (over: Partial<Parameters<typeof modePanelActions>[0]> = {}) => ({ session, isCloudModel: false, onChange: vi.fn(), onSandboxSetup: vi.fn(), ...over });

beforeEach(() => {
  session = { ...base };
  store.settings = { ...store.settings, savedModes: undefined, defaultSavedModeId: undefined };
  vi.stubGlobal('window', { innerWidth: 1400, innerHeight: 900, nekko: {
    setSessionOptions: vi.fn(async (_id: string, patch: Partial<Session>) => ({ ...session, ...patch })),
    updateSettings: vi.fn(async () => ({})), listTools: vi.fn(async () => []), openPath: vi.fn(),
  }, dispatchEvent: vi.fn() });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('Mode panel markup', () => {
  const html = () => renderToStaticMarkup(<ModePanel {...deps()} />);
  it('shows the rail, environment, privacy and approach settings without duplicate model controls', () => {
    const out = html();
    for (const name of STARTER_MODES.map((m) => m.name)) expect(out).toContain(name);
    for (const text of ['Environment', 'Privacy', 'Approach', 'Run on', 'Use worktrees', 'Incognito', 'Internet access', 'Approvals', 'Tools', 'MCP servers', 'Connectors', 'Skills', 'System prompt', 'Memory']) expect(out).toContain(text);
    expect(out).toContain('git-scm.com/docs/git-worktree');
    // Folder names and actions now live in the composer, not Mode.
    expect(out).not.toContain('agent-nekko');
    expect(out).not.toContain('mode-folders');
    expect(out).not.toContain('What folders does');
    // Explanation copy still ships, now as HoverTip labels on the row's info trigger.
    expect(out).toContain('data-hover-tip="Your machine, with your shell, apps and credentials.');
    expect(out).toContain('data-hover-tip="This chat is not saved to your history.');
  });
  it('puts the user\'s own modes first, under Custom, above the built-in ones', () => {
    expect(html()).not.toContain('data-mode-group="custom"');
    const mine = { id: 'careful', name: 'Careful', icon: 'sparkle' as const, options: starter('cloud').options };
    store.settings = { ...store.settings, savedModes: [...STARTER_MODES, mine] };
    const out = html();
    const at = (s: string) => out.indexOf(s);
    expect(at('data-mode-group="custom"')).toBeGreaterThan(-1);
    expect(at('data-mode-group="custom"')).toBeLessThan(at('data-saved-mode="careful"'));
    expect(at('data-saved-mode="careful"')).toBeLessThan(at('data-mode-group="starter"'));
    expect(at('data-mode-group="starter"')).toBeLessThan(at('data-saved-mode="cloud"'));
    expect(out).toContain('>Built-in</p>');
  });
  it('scrolls the modes on their own and keeps New mode outside the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `Mode ${i}`, icon: 'sparkle' as const, options: starter('cloud').options }));
    store.settings = { ...store.settings, savedModes: [...STARTER_MODES, ...many] };
    const list = html().match(/<div class="mode-rail-list"[^>]*>([\s\S]*?)<\/div><button[^>]*>.*?New mode/);
    expect(list).not.toBeNull();
    expect(list![1]).toContain('data-saved-mode="m29"');
    expect(list![1]).not.toContain('New mode');
  });
  it('marks the matching saved mode and the planned settings', () => {
    session = { ...base, cloudOnly: true };
    const out = html();
    expect(out).toMatch(/aria-checked="true"[^>]*data-saved-mode="cloud"/);
    expect(out).not.toContain("data-model-scope");
    expect(out.match(/Coming soon/g)).toHaveLength(1);
    expect(out).toMatch(/aria-checked="true"[^>]*data-memory="all"/);
    expect(out).toMatch(/aria-checked="true"[^>]*data-guidance="rules"/);
    expect(out).toMatch(/data-chat-mode="guardrails"|aria-checked="true"[^>]*data-chat-mode="guardrails"/);
  });
  it('counts MCP servers and connectors this chat sees', () => {
    store.settings = { ...store.settings, mcpServers: [{ id: 'web', name: 'web', enabled: true }, { id: 'files', name: 'files', enabled: true }, { id: 'off', name: 'off', enabled: false }], connectors: [{ kind: 'github', connected: true }, { kind: 'slack', connected: true }, { kind: 'linear', connected: false }] };
    session = { ...base, disabledMcpServers: ['web'], disabledConnectors: ['slack'] };
    const out = html();
    expect(out).toContain('1 of 3 on');
    expect(out).toContain('1 of 2 on');
    store.settings = { ...store.settings, mcpServers: [], connectors: [] };
  });
  it('offers code mode beside the tool list, marked new, with a link to what it is', () => {
    const out = renderToStaticMarkup(<ToolApproachPicker approach="list" onPick={() => {}} />);
    expect(out).toMatch(/role="radio" aria-checked="true"[^>]*data-tool-approach="list"/);
    expect(out).toMatch(/role="radio" aria-checked="false"[^>]*data-tool-approach="code"/);
    expect(out).toContain('Code mode<span class="mode-badge is-accent">New</span>');
    expect(out).toContain(`href="${CODE_MODE_DOCS}"`);
    // The link sits beside the options, never inside a radio button.
    expect(out).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<a /s);
    const sandboxed = renderToStaticMarkup(<ToolApproachPicker approach="list" locked="sandbox" onPick={() => {}} />);
    expect(sandboxed.match(/disabled=""/g)).toHaveLength(2);
    expect(sandboxed).toContain('Sandbox chats use the tool list');
    // Hovering a locked option says why it can't be picked.
    expect(sandboxed.match(/data-hover-tip="Sandbox chats always use the tool list."/g)).toHaveLength(2);
    expect(out).not.toContain('data-hover-tip');
    const claude = renderToStaticMarkup(<ToolApproachPicker approach="list" locked="claude-agent" onPick={() => {}} />);
    expect(claude.match(/disabled=""/g)).toHaveLength(2);
    expect(claude).toContain("Claude Agent chats run Claude Code&#x27;s own tools");
    expect(claude).toContain('data-hover-tip="Claude Agent uses Claude Code&#x27;s own tools. Pick a model other than Claude Code to choose."');
  });
  it('says on the Tools row when the chat is in code mode', () => {
    session = { ...base, toolApproach: 'code' } as Session;
    expect(html()).toContain('0 of 0 on · code mode');
    session = { ...base, toolApproach: 'code', executionMode: 'sandbox' } as Session;
    expect(html()).not.toContain('on · code mode');
  });
  it('never shows code mode as on for a Claude Agent chat, which the engine runs with a tool list', () => {
    store.providers = [{ id: 'cc', kind: 'claude-code', name: 'Claude' }];
    session = { ...base, toolApproach: 'code', providerId: 'cc' } as Session;
    expect(html()).not.toContain('on · code mode');
    store.providers = undefined;
  });
  it.each([undefined, false, true, 'true'])("shows Orchestrate independently of Tool style (%s)", (value) => {
    for (const toolApproach of ['code', 'list'] as const) {
      session = { ...base, toolApproach, orchestrate: value } as Session;
      expect(html()).toContain(`role="switch" aria-checked="${value === true}" aria-label="Orchestrate"`);
    }
  });
  it('leaves model and effort controls to the composer', () => {
    session = { ...base, effort: 'low' } as Session;
    const out = html();
    expect(out).not.toContain('Nekko router');
    expect(out).not.toContain('Models run');
    expect(out).not.toContain('Model router');
    expect(out).not.toContain('data-effort=');
    expect(out).not.toContain('What effort does');
  });
  it('locks internet on for a cloud model and approvals in a sandbox', () => {
    expect(renderToStaticMarkup(<ModePanel {...deps({ isCloudModel: true })} />)).toMatch(/aria-checked="true" aria-label="Internet access" class="quiet-switch mt-px" disabled/);
    session = { ...base, executionMode: 'sandbox' };
    expect(renderToStaticMarkup(<ModePanel {...deps()} />)).toContain('Sandbox always asks.');
  });
});

describe('Code mode on a Claude Agent chat', () => {
  const claude = [{ id: 'cc', kind: 'claude-code', name: 'Claude' }, { id: 'oa', kind: 'openai', name: 'OpenAI' }];
  const panel = (props: Record<string, unknown> = {}) => renderToStaticMarkup(<ModePanel {...deps()} {...props} />);
  afterEach(() => { store.providers = undefined; store.providersLoaded = true; });

  it('never shows code mode as on when the chat has no provider of its own and falls back to Claude Code', () => {
    store.providers = claude;
    session = { ...base, toolApproach: 'code' } as Session;
    // The chat window resolves the provider (saved default or first connected) and passes it down.
    expect(panel()).toContain('on · code mode');
    expect(panel({ providerId: 'cc' })).not.toContain('on · code mode');
    expect(panel({ providerId: 'oa' })).toContain('on · code mode');
  });
  it('locks the picker on Claude Code and says how to get code mode back', () => {
    expect(toolApproachLock(false, 'claude-agent')).toBe('claude-agent');
    expect(toolApproachLock(true, 'claude-agent')).toBe('sandbox');
    expect(toolApproachLock(false, 'other')).toBeNull();
    const out = renderToStaticMarkup(<ToolApproachPicker approach="list" locked="claude-agent" onPick={() => {}} />);
    expect(out).toContain('Pick a model other than Claude Code to use it.');
    expect(out.match(/disabled=""/g)).toHaveLength(2);
  });
  it('holds the picker until the provider list can say what runs the chat', () => {
    expect(chatEngine([], false, 'cc')).toBe('unknown');
    expect(toolApproachLock(false, 'unknown')).toBe('unknown');
    expect(chatEngine([], true, 'gone')).toBe('other');
    expect(chatEngine([], false, null)).toBe('other');
    expect(chatEngine(claude as never, true, 'cc')).toBe('claude-agent');
    store.providers = [];
    store.providersLoaded = false;
    session = { ...base, toolApproach: 'code' } as Session;
    expect(panel({ providerId: 'cc' })).not.toContain('on · code mode');
    const out = renderToStaticMarkup(<ToolApproachPicker approach="list" locked="unknown" onPick={() => {}} />);
    expect(out).toContain('data-tool-approach-lock="unknown"');
    expect(out.match(/disabled=""/g)).toHaveLength(2);
  });
  it('puts a chat that is on Claude Code back to the tool list on the chat alone', async () => {
    const api = { setSessionOptions: vi.fn(async (_id: string, patch: object) => ({ ...base, ...patch }) as Session) };
    await expect(dropCodeModeOnClaudeAgent(api, { id: 'chat', toolApproach: 'code' })).resolves.toMatchObject({ toolApproach: 'list' });
    expect(api.setSessionOptions).toHaveBeenCalledExactlyOnceWith('chat', { toolApproach: 'list' }, { chatOnly: true });
    expect(await dropCodeModeOnClaudeAgent(api, { id: 'chat', toolApproach: 'list' })).toBeNull();
    expect(await dropCodeModeOnClaudeAgent(api, { id: 'chat' })).toBeNull();
    expect(api.setSessionOptions).toHaveBeenCalledOnce();
  });
  it('leaves toolApproach out when a saved mode is applied to it, and out of the modes it saves', async () => {
    const d = deps({ claudeAgent: true } as never);
    await modePanelActions(d).applyMode(starter('local'));
    expect(window.nekko.setSessionOptions).toHaveBeenLastCalledWith('chat', expect.not.objectContaining({ toolApproach: expect.anything() }));
    await modePanelActions(deps()).applyMode(starter('local'));
    expect(window.nekko.setSessionOptions).toHaveBeenLastCalledWith('chat', expect.objectContaining({ toolApproach: 'code' }));
    session = { ...base, toolApproach: 'list' };
    store.settings = { ...store.settings, savedModes: [...STARTER_MODES, { id: 'mine', name: 'Mine', icon: 'sparkle', options: { ...starter('local').options, toolApproach: 'code' } }] };
    await modePanelActions(deps({ session, claudeAgent: true } as never)).updateMode('mine');
    expect(vi.mocked(window.nekko.updateSettings).mock.lastCall![0].savedModes!.at(-1)!.options.toolApproach).toBe('code');
    const saved = await modePanelActions(deps({ session, claudeAgent: true } as never)).saveMode('New', false);
    expect(saved.options.toolApproach).toBeUndefined();
  });
  it('still recognises a saved mode that pairs code mode with this chat', () => {
    session = { ...base, offline: true, toolApproach: 'list' };
    expect(chatModeState(session, store.settings).active?.id).not.toBe('local');
    expect(chatModeState(session, store.settings, { claudeAgent: true }).active?.id).toBe('local');
  });
});

describe('Mode panel writes', () => {
  it('writes only the boolean for this chat, never the tool style or app defaults', async () => {
    session.toolApproach = 'code';
    const d = deps();
    const actions = modePanelActions(d);
    await actions.setOrchestrate(true);
    await actions.setOrchestrate(false);
    expect(window.nekko.setSessionOptions).toHaveBeenNthCalledWith(1, 'chat', { orchestrate: true });
    expect(window.nekko.setSessionOptions).toHaveBeenNthCalledWith(2, 'chat', { orchestrate: false });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
    expect(d.onChange).toHaveBeenNthCalledWith(2, expect.objectContaining({ toolApproach: 'code', orchestrate: false }));
  });
  it('saves approvals as the default only after the chat took them', async () => {
    const d = deps();
    await modePanelActions(d).setApprovals('ask');
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { mode: 'ask' });
    expect(window.nekko.updateSettings).toHaveBeenCalledExactlyOnceWith({ defaultChatMode: 'ask' });
    vi.mocked(window.nekko.updateSettings).mockClear();
    vi.mocked(window.nekko.setSessionOptions).mockResolvedValueOnce(null);
    await modePanelActions(d).setApprovals('yolo');
    vi.mocked(window.nekko.setSessionOptions).mockRejectedValueOnce(new Error('unavailable'));
    await modePanelActions(d).setApprovals('yolo');
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
    expect(store.pushToast).toHaveBeenCalledWith('error', 'Error: unavailable');
  });
  it('asks before switching to YOLO, and changes nothing when the user keeps asking', async () => {
    const d = deps();
    yolo.allow.mockResolvedValueOnce(false);
    await modePanelActions(d).setApprovals('yolo');
    expect(yolo.allow).toHaveBeenCalledWith('guardrails', 'yolo');
    expect(window.nekko.setSessionOptions).not.toHaveBeenCalled();
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
    yolo.allow.mockResolvedValueOnce(false);
    await modePanelActions(d).applyMode({ ...starter('fusion'), options: { ...starter('fusion').options, mode: 'yolo' } });
    expect(window.nekko.setSessionOptions).not.toHaveBeenCalled();
  });
  it('keeps execution default persistence and sends Sandbox through its setup', async () => {
    const d = deps();
    await modePanelActions(d).setExecution('unified');
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { executionMode: 'unified', gitIsolation: false });
    expect(window.nekko.updateSettings).toHaveBeenCalledWith({ defaultExecutionMode: 'unified', gitManagement: { mode: 'shared' } });
    await modePanelActions(d).setExecution('sandbox');
    expect(d.onSandboxSetup).toHaveBeenCalledOnce();
  });
  it('sets code mode on this chat only', async () => {
    const d = deps();
    await modePanelActions(d).setToolApproach('code');
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { toolApproach: 'code' });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
    expect(d.onChange).toHaveBeenCalledWith(expect.objectContaining({ toolApproach: 'code' }));
  });
  it('sets a work mode on this chat only', async () => {
    await modePanelActions(deps()).setWorkMode('better-review');
    expect(window.nekko.setSessionOptions).toHaveBeenCalledExactlyOnceWith('chat', { workMode: 'better-review' });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });
  it('remembers effort on this computer after the chat accepts it', async () => {
    await modePanelActions(deps()).setEffort('max');
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { effort: 'max' });
    await modePanelActions(deps()).setEffort(null);
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { effort: null });
    expect(window.nekko.updateSettings).toHaveBeenCalledWith({ effort: 'max' });
  });
  it('switches MCP servers and connectors for this chat only', async () => {
    session = { ...base, disabledMcpServers: ['web'], disabledConnectors: ['slack'] };
    await modePanelActions(deps()).setMcpServer('files', false);
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { disabledMcpServers: ['files', 'web'] });
    await modePanelActions(deps()).setMcpServer('web', true);
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { disabledMcpServers: [] });
    await modePanelActions(deps()).setConnector('github', false);
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { disabledConnectors: ['github', 'slack'] });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });
  it('pins where this chat\'s models run, and unpins on a second click', async () => {
    await modePanelActions(deps({ isCloudModel: true })).setModelScope('cloud');
    expect(window.nekko.setSessionOptions).toHaveBeenLastCalledWith('chat', { cloudOnly: true, offline: false });
    await modePanelActions(deps()).setModelScope('local');
    expect(window.nekko.setSessionOptions).toHaveBeenLastCalledWith('chat', { offline: true, cloudOnly: false });
    await modePanelActions(deps()).setModelScope('fusion');
    expect(window.nekko.setSessionOptions).toHaveBeenLastCalledWith('chat', { offline: false, cloudOnly: false, autoModel: true, autoProviderSwitch: true });
    // Auto came on, so the open chat pane hears its model changed.
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
    session = { ...base, autoModel: true, autoProviderSwitch: true };
    await modePanelActions(deps()).setModelScope(null);
    expect(window.nekko.setSessionOptions).toHaveBeenLastCalledWith('chat', { autoProviderSwitch: false });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });
  it('explains instead of pinning a scope the chat\'s model cannot take', async () => {
    await modePanelActions(deps({ isCloudModel: true })).setModelScope('local');
    await modePanelActions(deps({ isCloudModel: false })).setModelScope('cloud');
    expect(window.nekko.setSessionOptions).not.toHaveBeenCalled();
    expect(store.pushToast).toHaveBeenCalledTimes(2);
    expect(store.pushToast).toHaveBeenCalledWith('info', expect.stringContaining('Pick a cloud model'));
  });
  it('never takes a cloud model offline', async () => {
    await modePanelActions(deps({ isCloudModel: true })).toggle('offline');
    expect(window.nekko.setSessionOptions).not.toHaveBeenCalled();
  });
});

describe('saved modes', () => {
  it('applies every setting, effort included, in one per-chat write', async () => {
    const d = deps();
    await modePanelActions(d).applyMode({ ...starter('fusion'), options: { ...starter('fusion').options, mode: 'yolo', effort: 'high' } });
    expect(window.nekko.setSessionOptions).toHaveBeenCalledExactlyOnceWith('chat', { executionMode: 'worktree', gitIsolation: true, mode: 'yolo', offline: false, incognito: false, disabledTools: [], workMode: 'default', effort: 'high', cloudOnly: false, autoModel: true, autoProviderSwitch: true });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
    expect(d.onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'yolo' }));
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });
  it('says what a starter could not set for the chat\'s model', async () => {
    await modePanelActions(deps({ isCloudModel: true })).applyMode(starter('local'));
    expect(vi.mocked(window.nekko.setSessionOptions).mock.calls[0][1]).not.toHaveProperty('offline');
    expect(store.pushToast).toHaveBeenCalledWith('info', expect.stringContaining('Pick a local model'));
    await modePanelActions(deps({ isCloudModel: false })).applyMode(starter('cloud'));
    expect(vi.mocked(window.nekko.setSessionOptions).mock.calls[1][1]).not.toHaveProperty('cloudOnly');
    expect(store.pushToast).toHaveBeenCalledWith('info', expect.stringContaining('Pick a cloud model'));
  });
  it('opens sandbox setup instead of moving a chat into a sandbox unasked', async () => {
    const d = deps();
    await modePanelActions(d).applyMode(starter('risky-business'));
    const patch = vi.mocked(window.nekko.setSessionOptions).mock.calls[0][1];
    expect(patch).not.toHaveProperty('executionMode');
    expect(d.onSandboxSetup).toHaveBeenCalledOnce();
  });
  it('saves, updates, stars and deletes modes in settings', async () => {
    session = { ...base, mode: 'ask', disabledTools: ['bash'] };
    const saved = await modePanelActions(deps()).saveMode('Careful', true);
    expect(window.nekko.updateSettings).toHaveBeenLastCalledWith({ savedModes: [...STARTER_MODES, saved], defaultSavedModeId: 'careful' });
    expect(saved.options).toMatchObject({ mode: 'ask', disabledTools: ['bash'], executionMode: 'worktree' });
    store.settings = { ...store.settings, savedModes: [...STARTER_MODES, saved], defaultSavedModeId: 'careful' };
    // Now edited away from Careful: the panel offers Update and Revert.
    session = { ...session, incognito: true };
    expect(chatModeState(session, store.settings)).toMatchObject({ active: undefined, edited: { id: 'careful' } });
    await modePanelActions(deps()).updateMode('careful');
    expect(vi.mocked(window.nekko.updateSettings).mock.lastCall![0].savedModes!.at(-1)!.options.incognito).toBe(true);
    await modePanelActions(deps()).toggleDefault('careful');
    expect(window.nekko.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ defaultSavedModeId: undefined }));
    await modePanelActions(deps()).deleteMode('careful');
    expect(window.nekko.updateSettings).toHaveBeenLastCalledWith({ savedModes: STARTER_MODES, defaultSavedModeId: undefined });
  });
  it('labels the Mode button with the saved mode, or Custom', () => {
    expect(modeButtonLabel({ ...session, cloudOnly: true }, store.settings)).toMatchObject({ name: 'Cloud only', summary: 'worktree · cloud models' });
    expect(modeButtonLabel({ ...session, cloudOnly: true, disabledTools: ['grep'] }, store.settings).name).toBe('Custom');
    expect(modeButtonLabel(session, store.settings)).toMatchObject({ name: 'Custom', summary: 'worktree' });
    // A Claude Agent chat never runs in code mode, so its label doesn't claim it.
    expect(modeButtonLabel({ ...session, toolApproach: 'code' }, store.settings).summary).toContain('code mode');
    expect(modeButtonLabel({ ...session, toolApproach: 'code' }, store.settings, { claudeAgent: true }).summary).not.toContain('code mode');
  });
  it('draws each chosen option as its Mode panel icon, and none for running locally', () => {
    const icons = modeButtonLabel({ ...session, mode: 'yolo', incognito: true }, store.settings).parts.map((p) => [p.key, !!summaryPartIcon(p)]);
    expect(icons).toEqual([['where', true], ['approvals', true], ['incognito', true]]);
    expect(summaryPartIcon({ key: 'where', value: 'local', label: 'local' })).toBeNull();
  });
});

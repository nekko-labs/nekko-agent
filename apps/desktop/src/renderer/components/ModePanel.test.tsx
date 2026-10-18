import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@nekko-agent/shared';
import { STARTER_MODES } from '@nekko-agent/shared';
import { ModePanel, chatModeState, modeButtonLabel, modePanelActions } from './ModePanel.js';

const store = vi.hoisted(() => ({
  settings: { defaultChatMode: 'guardrails', gitManagement: { mode: 'worktree' }, effort: 'normal', workspaces: [{ id: 'w1', name: 'agent-nekko', path: '/code/agent-nekko', addedAt: 1 }], mcpServers: [] } as Record<string, any>,
  refreshSettings: vi.fn(async () => {}),
  pushToast: vi.fn(),
}));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: typeof store) => unknown) => select(store), { getState: () => store }) }));
vi.mock('../sessionFolders.js', () => ({ addFolderToChat: vi.fn(), applyFolderSelection: vi.fn(), withExcluded: vi.fn() }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));

const base = { id: 'chat', messages: [], executionMode: 'worktree', gitIsolation: true, workspaceId: 'w1' } as unknown as Session;
let session: Session;
const deps = (over: Partial<Parameters<typeof modePanelActions>[0]> = {}) => ({ session, isCloudModel: false, onChange: vi.fn(), onSandboxSetup: vi.fn(), ...over });

beforeEach(() => {
  session = { ...base };
  store.settings = { ...store.settings, savedModes: undefined, defaultSavedModeId: undefined };
  vi.stubGlobal('window', { innerWidth: 1400, innerHeight: 900, nekko: {
    setSessionOptions: vi.fn(async (_id: string, patch: Partial<Session>) => ({ ...session, ...patch })),
    updateSettings: vi.fn(async () => ({})), listTools: vi.fn(async () => []), openPath: vi.fn(),
  } });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('Mode panel markup', () => {
  const html = () => renderToStaticMarkup(<ModePanel {...deps()} />);
  it('shows the rail, the four sections and every setting', () => {
    const out = html();
    for (const name of STARTER_MODES.map((m) => m.name)) expect(out).toContain(name);
    for (const text of ['Environment', 'Model', 'Privacy', 'Approach', 'Run on', 'Use worktrees', 'Incognito', 'Internet access', 'Folders', 'Approvals', 'Tools', 'MCP servers', 'Connectors', 'Skills', 'System prompt', 'Memory', 'Model router', 'Effort']) expect(out).toContain(text);
    expect(out).toContain('git-scm.com/docs/git-worktree');
    expect(out).toContain('agent-nekko');
  });
  it('marks the matching saved mode and the planned settings', () => {
    const out = html();
    expect(out).toMatch(/aria-checked="true"[^>]*data-saved-mode="everyday"/);
    expect(out.match(/Coming soon/g)).toHaveLength(3);
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
  it('follows the chat effort over the app default', () => {
    session = { ...base, effort: 'low' } as Session;
    const out = html();
    expect(out).toMatch(/aria-checked="true" data-effort="low"/);
    expect(out).toContain('Use the app default');
  });
  it('locks internet on for a cloud model and approvals in a sandbox', () => {
    expect(renderToStaticMarkup(<ModePanel {...deps({ isCloudModel: true })} />)).toMatch(/aria-checked="true" aria-label="Internet access" class="mode-switch" disabled/);
    session = { ...base, executionMode: 'sandbox' };
    expect(renderToStaticMarkup(<ModePanel {...deps()} />)).toContain('Sandbox always asks first.');
  });
});

describe('Mode panel writes', () => {
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
  it('keeps execution default persistence and sends Sandbox through its setup', async () => {
    const d = deps();
    await modePanelActions(d).setExecution('unified');
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { executionMode: 'unified', gitIsolation: false });
    expect(window.nekko.updateSettings).toHaveBeenCalledWith({ defaultExecutionMode: 'unified', gitManagement: { mode: 'shared' } });
    await modePanelActions(d).setExecution('sandbox');
    expect(d.onSandboxSetup).toHaveBeenCalledOnce();
  });
  it('sets a work mode on this chat only', async () => {
    await modePanelActions(deps()).setWorkMode('better-review');
    expect(window.nekko.setSessionOptions).toHaveBeenCalledExactlyOnceWith('chat', { workMode: 'better-review' });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });
  it('sets effort on this chat, and clears it back to the app default', async () => {
    await modePanelActions(deps()).setEffort('max');
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { effort: 'max' });
    await modePanelActions(deps()).setEffort(null);
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { effort: null });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
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
  it('never takes a cloud model offline', async () => {
    await modePanelActions(deps({ isCloudModel: true })).toggle('offline');
    expect(window.nekko.setSessionOptions).not.toHaveBeenCalled();
  });
});

describe('saved modes', () => {
  it('applies every setting, effort included, in one per-chat write', async () => {
    const d = deps();
    await modePanelActions(d).applyMode(STARTER_MODES[1]);
    expect(window.nekko.setSessionOptions).toHaveBeenCalledExactlyOnceWith('chat', { executionMode: 'worktree', gitIsolation: true, mode: 'yolo', offline: false, incognito: false, disabledTools: [], workMode: 'best-output', effort: 'high' });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
    expect(d.onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'yolo' }));
  });
  it('opens sandbox setup instead of moving a chat into a sandbox unasked', async () => {
    const d = deps();
    await modePanelActions(d).applyMode(STARTER_MODES[3]);
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
    expect(modeButtonLabel(session, store.settings)).toMatchObject({ name: 'Everyday', summary: 'worktree' });
    expect(modeButtonLabel({ ...session, disabledTools: ['grep'] }, store.settings).name).toBe('Custom');
  });
});

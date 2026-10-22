import { describe, expect, it } from 'vitest';
import { STARTER_MODES, chatModelScope, defaultSavedMode, matchSavedMode, modePatchSkips, newSavedModeId, savedModes, sessionModeOptions, sessionPatchForMode, savedModeSummary } from './saved-modes.js';

const starter = (id: string) => STARTER_MODES.find((m) => m.id === id)!;

describe('saved modes', () => {
  it('starts with the starter set and no default', () => {
    expect(savedModes(undefined)).toBe(STARTER_MODES);
    expect(defaultSavedMode({})).toBeUndefined();
    expect(defaultSavedMode({ defaultSavedModeId: 'local' })?.name).toBe('Local only');
    expect(STARTER_MODES.map((m) => m.name)).toEqual(['Cloud only', 'Fusion', 'Local only', 'Risky business']);
    expect(defaultSavedMode({ defaultSavedModeId: 'gone' })).toBeUndefined();
  });

  it('reads a chat the way the engine runs it', () => {
    expect(sessionModeOptions({ executionMode: 'sandbox', mode: 'yolo' })).toMatchObject({ executionMode: 'sandbox', mode: 'ask' });
    expect(sessionModeOptions({}, { defaultChatMode: 'yolo' })).toMatchObject({ executionMode: 'worktree', mode: 'yolo', workMode: 'default', offline: false, incognito: false });
    expect(sessionModeOptions({ disabledTools: ['grep', 'bash'] }).disabledTools).toEqual(['bash', 'grep']);
  });

  it('matches a chat to the mode that would produce it', () => {
    const plain = sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails' }, { effort: 'low' });
    // A chat that pins nothing about its models is none of the model starters.
    expect(plain.models).toBeUndefined();
    expect(matchSavedMode(STARTER_MODES, plain)).toBeUndefined();
    expect(matchSavedMode(STARTER_MODES, sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails', cloudOnly: true }))?.id).toBe('cloud');
    expect(matchSavedMode(STARTER_MODES, sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails', autoModel: true, autoProviderSwitch: true }))?.id).toBe('fusion');
    expect(matchSavedMode(STARTER_MODES, sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails', offline: true, toolApproach: 'code' }))?.id).toBe('local');
    expect(matchSavedMode(STARTER_MODES, sessionModeOptions({ executionMode: 'worktree', mode: 'ask', cloudOnly: true }))).toBeUndefined();
    // Effort pinned by a mode must match.
    const pinned = { id: 'p', name: 'P', icon: 'dial' as const, options: { ...starter('cloud').options, effort: 'high' as const } };
    const cloud = sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails', cloudOnly: true }, { effort: 'low' });
    expect(matchSavedMode([pinned], cloud)).toBeUndefined();
    expect(matchSavedMode([pinned], { ...cloud, effort: 'high' })?.id).toBe('p');
  });

  it('runs Local only in code mode, and a mode that sets no approach leaves the chat\'s', () => {
    expect(starter('local').options.toolApproach).toBe('code');
    expect(STARTER_MODES.filter((m) => m.options.toolApproach).map((m) => m.id)).toEqual(['local']);
    expect(sessionModeOptions({}).toolApproach).toBe('list');
    // An offline chat that still lists its tools has been changed from Local only.
    expect(matchSavedMode(STARTER_MODES, sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails', offline: true }))).toBeUndefined();
    expect(sessionPatchForMode(starter('local').options, { cloudModel: false })).toMatchObject({ toolApproach: 'code', offline: true });
    expect(sessionPatchForMode(starter('cloud').options)).not.toHaveProperty('toolApproach');
    // Cloud only sets no approach, so a cloud chat in code mode is still in it.
    expect(matchSavedMode(STARTER_MODES, sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails', cloudOnly: true, toolApproach: 'code' }))?.id).toBe('cloud');
    expect(savedModeSummary(starter('local').options)).toBe('worktree · local models · code mode');
  });

  it('reads where a chat\'s models run', () => {
    expect(chatModelScope({})).toBeUndefined();
    expect(chatModelScope({ autoModel: true })).toBeUndefined();
    expect(chatModelScope({ autoModel: true, autoProviderSwitch: true })).toBe('fusion');
    expect(chatModelScope({ cloudOnly: true, autoModel: true, autoProviderSwitch: true })).toBe('cloud');
    expect(chatModelScope({ offline: true, cloudOnly: true })).toBe('local');
  });

  it('matches a sandbox chat to Risky business on a cloud model too', () => {
    // The container has no network either way; a cloud model cannot go offline.
    const sandboxCloud = sessionModeOptions({ executionMode: 'sandbox', mode: 'yolo' });
    expect(sandboxCloud.offline).toBe(false);
    expect(matchSavedMode(STARTER_MODES, sandboxCloud)?.id).toBe('risky-business');
    expect(matchSavedMode(STARTER_MODES, sessionModeOptions({ executionMode: 'sandbox', offline: true }))?.id).toBe('risky-business');
    expect(matchSavedMode(STARTER_MODES, { ...sandboxCloud, incognito: true })).toBeUndefined();
  });

  it('puts the model scope in the patch, holding back what the chat\'s model cannot take', () => {
    expect(sessionPatchForMode(starter('cloud').options, { cloudModel: true })).toMatchObject({ cloudOnly: true, offline: false });
    expect(sessionPatchForMode(starter('cloud').options, { cloudModel: false })).not.toHaveProperty('cloudOnly');
    expect(sessionPatchForMode(starter('cloud').options)).toMatchObject({ cloudOnly: true });
    expect(sessionPatchForMode(starter('fusion').options, { cloudModel: false })).toMatchObject({ cloudOnly: false, offline: false, autoModel: true, autoProviderSwitch: true });
    expect(sessionPatchForMode(starter('local').options, { cloudModel: false })).toMatchObject({ cloudOnly: false, offline: true });
    expect(sessionPatchForMode(starter('local').options, { cloudModel: true })).not.toHaveProperty('offline');
    expect(sessionPatchForMode(starter('risky-business').options, { cloudModel: false })).toMatchObject({ executionMode: 'sandbox', mode: 'ask', offline: true });
    expect(sessionPatchForMode({ ...starter('cloud').options, models: undefined })).not.toHaveProperty('cloudOnly');

    expect(modePatchSkips(starter('local').options, { cloudModel: true })).toBe('offline');
    expect(modePatchSkips(starter('cloud').options, { cloudModel: false })).toBe('cloudOnly');
    expect(modePatchSkips(starter('risky-business').options, { cloudModel: true })).toBeUndefined();
    expect(modePatchSkips(starter('fusion').options, { cloudModel: false })).toBeUndefined();
  });

  it('turns a mode into a per-chat patch without taking a cloud model offline', () => {
    const offline = { ...starter('cloud').options, models: undefined, offline: true };
    expect(sessionPatchForMode(offline)).toMatchObject({ offline: true, gitIsolation: true, executionMode: 'worktree' });
    expect(sessionPatchForMode(offline, { cloudModel: true })).not.toHaveProperty('offline');
    expect(sessionPatchForMode(starter('cloud').options)).not.toHaveProperty('effort');
  });

  it('reads effort, MCP servers and connectors from the chat', () => {
    expect(sessionModeOptions({}, { effort: 'high' })).toMatchObject({ effort: 'high', disabledMcpServers: [], disabledConnectors: [] });
    expect(sessionModeOptions({ effort: 'low', disabledMcpServers: ['web', 'files'], disabledConnectors: ['slack'] }, { effort: 'high' }))
      .toMatchObject({ effort: 'low', disabledMcpServers: ['files', 'web'], disabledConnectors: ['slack'] });
  });

  it('matches MCP servers and connectors, and lets an older mode without them match any', () => {
    const mine = { id: 'mine', name: 'Mine', icon: 'sparkle' as const, options: { ...starter('cloud').options, disabledMcpServers: ['web'], disabledConnectors: [] } };
    const chat = sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails', cloudOnly: true, disabledMcpServers: ['web'] });
    expect(matchSavedMode([mine], chat)?.id).toBe('mine');
    expect(matchSavedMode([mine], { ...chat, disabledMcpServers: [] })).toBeUndefined();
    expect(matchSavedMode([mine], { ...chat, disabledConnectors: ['slack'] })).toBeUndefined();
    // The starters leave servers and connectors as they are.
    expect(matchSavedMode(STARTER_MODES, { ...chat, disabledConnectors: ['slack'] })?.id).toBe('cloud');
  });

  it('puts effort, MCP servers and connectors in the patch only when the mode sets them', () => {
    const options = { ...starter('fusion').options, effort: 'high' as const, disabledMcpServers: ['web'], disabledConnectors: ['slack'] };
    expect(sessionPatchForMode(options)).toMatchObject({ effort: 'high', disabledMcpServers: ['web'], disabledConnectors: ['slack'] });
    const older = sessionPatchForMode(starter('cloud').options);
    expect(older).not.toHaveProperty('disabledMcpServers');
    expect(older).not.toHaveProperty('disabledConnectors');
  });

  it('carries memory and project rules, and lets an older mode without them match any', () => {
    expect(sessionModeOptions({})).toMatchObject({ memory: 'all', guidance: 'rules' });
    const chat = sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails', cloudOnly: true, memory: 'project', guidance: 'root' });
    const focused = { id: 'focused', name: 'Focused', icon: 'dial' as const, options: { ...STARTER_MODES[0].options, memory: 'off' as const, guidance: 'root' as const } };
    expect(matchSavedMode([focused], chat)).toBeUndefined();
    expect(matchSavedMode([focused], { ...chat, memory: 'off' })?.id).toBe('focused');
    expect(matchSavedMode(STARTER_MODES, chat)?.id).toBe('cloud');
    expect(sessionPatchForMode(focused.options)).toMatchObject({ memory: 'off', guidance: 'root' });
    expect(sessionPatchForMode(STARTER_MODES[0].options)).not.toHaveProperty('memory');
    expect(savedModeSummary(focused.options)).toBe('worktree · cloud models · memory off · rules root');
  });

  it('summarizes and names modes', () => {
    expect(STARTER_MODES.map((m) => savedModeSummary(m.options))).toEqual(['worktree · cloud models', 'worktree · local + cloud', 'worktree · local models · code mode', 'sandbox · ask · no network']);
    expect(savedModeSummary({ ...starter('cloud').options, models: undefined, mode: 'yolo', offline: true, effort: 'high' })).toBe('worktree · yolo · offline · high');
    expect(newSavedModeId('Fusion', STARTER_MODES)).toBe('fusion-2');
    expect(newSavedModeId('  !!  ', [])).toBe('mode');
  });
});

import { describe, expect, it } from 'vitest';
import { STARTER_MODES, defaultSavedMode, matchSavedMode, newSavedModeId, savedModes, sessionModeOptions, sessionPatchForMode, savedModeSummary } from './saved-modes.js';

describe('saved modes', () => {
  it('starts with the starter set and no default', () => {
    expect(savedModes(undefined)).toBe(STARTER_MODES);
    expect(defaultSavedMode({})).toBeUndefined();
    expect(defaultSavedMode({ defaultSavedModeId: 'private' })?.name).toBe('Private');
    expect(defaultSavedMode({ defaultSavedModeId: 'gone' })).toBeUndefined();
  });

  it('reads a chat the way the engine runs it', () => {
    expect(sessionModeOptions({ executionMode: 'sandbox', mode: 'yolo' })).toMatchObject({ executionMode: 'sandbox', mode: 'ask' });
    expect(sessionModeOptions({}, { defaultChatMode: 'yolo' })).toMatchObject({ executionMode: 'worktree', mode: 'yolo', workMode: 'default', offline: false, incognito: false });
    expect(sessionModeOptions({ disabledTools: ['grep', 'bash'] }).disabledTools).toEqual(['bash', 'grep']);
  });

  it('matches a chat to the mode that would produce it', () => {
    const everyday = sessionModeOptions({ executionMode: 'worktree', mode: 'guardrails' }, { effort: 'low' });
    expect(matchSavedMode(STARTER_MODES, everyday)?.id).toBe('everyday');
    expect(matchSavedMode(STARTER_MODES, { ...everyday, incognito: true, mode: 'ask' })?.id).toBe('private');
    expect(matchSavedMode(STARTER_MODES, { ...everyday, disabledTools: ['bash'] })).toBeUndefined();
    // Deep work pins effort, so a different app-wide effort is not Deep work.
    const deep = { ...STARTER_MODES[1].options, effort: 'low' as const };
    expect(matchSavedMode(STARTER_MODES, deep)).toBeUndefined();
    expect(matchSavedMode(STARTER_MODES, { ...deep, effort: 'high' })?.id).toBe('deep-work');
  });

  it('turns a mode into a per-chat patch without taking a cloud model offline', () => {
    const offline = { ...STARTER_MODES[0].options, offline: true };
    expect(sessionPatchForMode(offline)).toMatchObject({ offline: true, gitIsolation: true, executionMode: 'worktree' });
    expect(sessionPatchForMode(offline, { cloudModel: true })).not.toHaveProperty('offline');
    expect(sessionPatchForMode(STARTER_MODES[0].options)).not.toHaveProperty('effort');
  });

  it('summarizes and names modes', () => {
    expect(savedModeSummary(STARTER_MODES[1].options)).toBe('worktree · yolo · high');
    expect(savedModeSummary(STARTER_MODES[0].options)).toBe('worktree');
    expect(newSavedModeId('Deep work', STARTER_MODES)).toBe('deep-work-2');
    expect(newSavedModeId('  !!  ', [])).toBe('mode');
  });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatWorktreeInfo } from '@nekko-agent/shared';
import { WorktreeGroups, groupWorktrees, worktreeBlocked } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));

const wt = (over: Partial<ChatWorktreeInfo>): ChatWorktreeInfo => ({
  root: 'C:/code/app/.git/nekko-worktrees/brisk-amber-otter',
  sourceRoot: 'C:/code/app',
  projectName: 'app',
  branch: 'nekko/brisk-amber-otter',
  sessionId: 's1',
  sessionTitle: 'Fix login',
  running: false,
  madeByChat: true,
  dirtyCount: 0,
  unmergedCount: 0,
  ...over,
});

describe('Git management worktrees', () => {
  const byHand = wt({ root: 'C:/code/app/.worktrees/by-hand', branch: 'fix/by-hand', sessionId: 'by-hand', sessionTitle: undefined, madeByChat: false });
  const chat = wt({});
  const other = wt({ root: 'C:/code/site/.worktrees/x', sourceRoot: 'C:/code/site', projectName: 'site', madeByChat: false, sessionTitle: undefined });

  it('groups by repository, chat worktrees before those made outside Nekko', () => {
    const groups = groupWorktrees([byHand, other, chat]);
    expect(groups.map((g) => g.label)).toEqual(['app', 'site']);
    expect(groups[0].rows).toEqual([chat, byHand]);
  });

  it('names chat worktrees by chat and others by folder, with a note', () => {
    const html = renderToStaticMarkup(<WorktreeGroups worktrees={[chat, byHand]} busy={null} onRemove={() => {}} />);
    expect(html).toContain('Fix login');
    expect(html).toContain('by-hand');
    expect(html).toContain('Made outside Nekko · fix/by-hand');
    expect(html.match(/Made outside Nekko/g)).toHaveLength(1);
  });

  it('disables Remove on a locked worktree and says why', () => {
    const locked = wt({ locked: true, lockedReason: 'agent busy', madeByChat: false });
    expect(worktreeBlocked(locked)).toBe('Locked (agent busy). Unlock it with git worktree unlock first.');
    const html = renderToStaticMarkup(<WorktreeGroups worktrees={[locked]} busy={null} onRemove={() => {}} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="Locked (agent busy). Unlock it with git worktree unlock first."');
    expect(worktreeBlocked(wt({ dirtyCount: 2 }))).toBe('Has uncommitted changes.');
    expect(worktreeBlocked(chat)).toBe('');
  });

  it('treats an older host without madeByChat as chat worktrees', () => {
    const old = wt({ madeByChat: undefined });
    const html = renderToStaticMarkup(<WorktreeGroups worktrees={[old]} busy={null} onRemove={() => {}} />);
    expect(html).not.toContain('Made outside Nekko');
    expect(html).toContain('Fix login');
  });
});

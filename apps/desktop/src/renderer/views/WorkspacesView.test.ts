import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@nekko-agent/shared';
import type { Workspace } from '../store.js';
import { sidebarWorkspaces, unopenedChats } from './unopenedChats.js';

const chat = (id: string, extra: Partial<SessionSummary> = {}) => ({
  id, title: id, createdAt: 1, updatedAt: 1, ...extra,
}) as SessionSummary;

const workspace = (id: string): Workspace => ({
  id: `ws_${id}`, anchor: { kind: 'chat', refId: id },
  root: { id: `pane_${id}`, kind: 'chat', refId: id }, activePaneId: `pane_${id}`,
});

describe('unopenedChats', () => {
  it('keeps active chats listed after their workspace is closed, without duplicating open chats', () => {
    const sessions = [chat('old'), chat('open'), chat('archived', { archivedAt: 100 })];
    expect(unopenedChats(sessions, [workspace('open')]).map((s) => s.id)).toEqual(['old']);
    expect(unopenedChats(sessions, []).map((s) => s.id)).toEqual(['old', 'open']);
  });

  it('keeps children reachable when their parent is saved but has no sidebar workspace', () => {

    expect(unopenedChats([chat('parent'), chat('child', { parentSessionId: 'parent' })], [])
      .map((s) => s.id)).toEqual(['parent', 'child']);
  });

  it('excludes only children actually rendered beneath an open anchor', () => {
    const sessions = [chat('parent'), chat('running', { parentSessionId: 'parent' }), chat('finished', { parentSessionId: 'parent', lastReplyText: 'Done' })];
    expect(unopenedChats(sessions, [workspace('parent')], new Set(['running']))
      .map((s) => s.id)).toEqual(['finished']);
  });

  it('keeps split-pane chats reachable because only the anchor has a sidebar card', () => {
    const w = workspace('anchor');
    w.root = { id: 'split', dir: 'row', sizes: [0.5, 0.5], children: [
      w.root!, { id: 'pane_split-chat', kind: 'chat', refId: 'split-chat' },
    ] };
    expect(unopenedChats([chat('anchor'), chat('split-chat')], [w]).map((s) => s.id)).toEqual(['split-chat']);
  });

  it('keeps orphaned and archived-parent children reachable', () => {
    const sessions = [chat('parent', { archivedAt: 100 }), chat('child', { parentSessionId: 'parent' }), chat('orphan', { parentSessionId: 'missing' })];
    expect(unopenedChats(sessions, []).map((s) => s.id)).toEqual(['child', 'orphan']);
  });
});


describe('sidebarWorkspaces', () => {
  it('does not promote nested subagents to full rows when their transcripts are opened', () => {
    const workspaces = [workspace('parent'), workspace('child-1'), workspace('child-2'), workspace('ordinary')];
    const nested = new Set(['child-1', 'child-2']);
    expect(sidebarWorkspaces(workspaces, nested).map((w) => w.anchor.refId)).toEqual(['parent', 'ordinary']);
    expect(workspaces).toHaveLength(4);
  });

  it('retains terminal workspaces and children without a rendered parent', () => {
    const terminal = { ...workspace('terminal'), anchor: { kind: 'terminal' as const, refId: 'terminal' } };
    expect(sidebarWorkspaces([workspace('orphan'), workspace('finished'), terminal], new Set(['terminal']))
      .map((w) => w.anchor.refId)).toEqual(['orphan', 'finished', 'terminal']);
  });

  it('excludes nested children from both open and saved rows when the parent workspace is closed', () => {
    const sessions = [chat('parent'), chat('child', { parentSessionId: 'parent' })];
    const nested = new Set(['child']);
    expect(sidebarWorkspaces([workspace('child')], nested)).toEqual([]);
    expect(unopenedChats(sessions, [workspace('child')], nested).map((s) => s.id)).toEqual(['parent']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PANEL_VIEW, STATUS_GROUPS, canReorder, compareCards, dateGroupOf, groupActivityOf, isDefaultView,
  parseAgentPanelView, statusGroupOf, withSort, type SortableCard,
} from './agentPanelView.js';

const card = (title: string, updatedAt: number, createdAt: number, order?: number): SortableCard => ({ title, updatedAt, createdAt, order });

describe('agent panel view', () => {
  it('defaults to grouping by activity', () => {
    expect(DEFAULT_AGENT_PANEL_VIEW).toEqual({
      groupBy: 'status', sortBy: 'manual', direction: 'desc',
      showMetadata: true, showProvider: true, showAutomations: true, showEmptyGroups: true,
      showComputer: true,
      showComputerIcons: true,
    });
    expect(isDefaultView(DEFAULT_AGENT_PANEL_VIEW)).toBe(true);
    expect(isDefaultView({ ...DEFAULT_AGENT_PANEL_VIEW, showMetadata: false })).toBe(false);
  });

  it('reads a saved view and drops anything no longer valid', () => {
    expect(parseAgentPanelView(null)).toBe(DEFAULT_AGENT_PANEL_VIEW);
    expect(parseAgentPanelView('not json')).toBe(DEFAULT_AGENT_PANEL_VIEW);
    expect(parseAgentPanelView(JSON.stringify({ groupBy: 'project', sortBy: 'bogus', direction: 'asc', showMetadata: false, showProvider: false, showAutomations: 'yes' })))
      .toEqual({ ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'project', direction: 'asc', showMetadata: false, showProvider: false });
  });

  it('only lets cards be dragged into order where that order is what the panel shows', () => {
    const byProject = { ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'project' as const };
    expect(canReorder(byProject)).toBe(true);
    expect(canReorder({ ...byProject, sortBy: 'name' })).toBe(false);
    expect(canReorder(DEFAULT_AGENT_PANEL_VIEW)).toBe(false);
  });

  it('starts names A to Z and dates newest first when a sort is picked', () => {
    expect(withSort(DEFAULT_AGENT_PANEL_VIEW, 'name').direction).toBe('asc');
    expect(withSort({ ...DEFAULT_AGENT_PANEL_VIEW, direction: 'asc' }, 'created').direction).toBe('desc');
    const asc = { ...DEFAULT_AGENT_PANEL_VIEW, sortBy: 'updated' as const, direction: 'asc' as const };
    expect(withSort(asc, 'updated')).toBe(asc);
  });

  it('sorts manually dragged cards first, then by recency', () => {
    const cards = [card('a', 1, 1), card('b', 5, 5), card('c', 2, 2, 1), card('d', 9, 9, 0)];
    expect(cards.sort(compareCards({ sortBy: 'manual', direction: 'desc' })).map((c) => c.title)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('sorts by last updated, date created and name in either direction', () => {
    const cards = () => [card('beta', 3, 1), card('Alpha', 1, 3), card('gamma 10', 2, 2), card('gamma 9', 0, 0)];
    const titles = (sortBy: 'updated' | 'created' | 'name', direction: 'asc' | 'desc') => cards().sort(compareCards({ sortBy, direction })).map((c) => c.title);
    expect(titles('updated', 'desc')).toEqual(['beta', 'gamma 10', 'Alpha', 'gamma 9']);
    expect(titles('updated', 'asc')).toEqual(['gamma 9', 'Alpha', 'gamma 10', 'beta']);
    expect(titles('created', 'desc')).toEqual(['Alpha', 'gamma 10', 'beta', 'gamma 9']);
    expect(titles('name', 'asc')).toEqual(['Alpha', 'beta', 'gamma 9', 'gamma 10']);
    expect(titles('name', 'desc')).toEqual(['gamma 10', 'gamma 9', 'beta', 'Alpha']);
  });

  it('lists the agent loop in order, with Needs input and Draft above it', () => {
    expect(STATUS_GROUPS.map((g) => g.name)).toEqual(['Needs input', 'Draft', 'Building', 'Verifying', 'Watching', 'Done']);
  });

  it('files a working chat under its loop phase, and a chat nothing was sent in under Draft', () => {
    expect(statusGroupOf({ exchangeCount: 0 }, undefined)).toBe('status:draft');
    expect(statusGroupOf({ exchangeCount: 2, phase: 'building' }, 'working')).toBe('status:building');
    expect(statusGroupOf({ exchangeCount: 2, phase: 'verifying' }, 'error')).toBe('status:verifying');
  });

  it('files a working chat that is landing its work under Verifying', () => {
    expect(statusGroupOf({ exchangeCount: 2, phase: 'shipping' }, 'working')).toBe('status:verifying');
  });

  it('files a stopped chat under Done, or Watching while a watch is armed', () => {
    expect(statusGroupOf({ exchangeCount: 2, phase: 'building' }, undefined)).toBe('status:done');
    expect(statusGroupOf({ exchangeCount: 2, phase: 'shipping', activeWatchCount: 0 }, undefined)).toBe('status:done');
    expect(statusGroupOf({ exchangeCount: 2, phase: 'shipping', activeWatchCount: 1 }, undefined)).toBe('status:watching');
    expect(statusGroupOf({ exchangeCount: 2, activeWatchCount: 2 }, 'idle')).toBe('status:watching');
    expect(statusGroupOf({ exchangeCount: 2 }, 'done')).toBe('status:done');
    // A watch wakes a working chat: it is in its phase while it works.
    expect(statusGroupOf({ exchangeCount: 2, phase: 'building', activeWatchCount: 1 }, 'working')).toBe('status:building');
  });

  it('files a chat waiting on you under Needs input, whatever its phase', () => {
    expect(statusGroupOf({ exchangeCount: 2, phase: 'building' }, 'input')).toBe('status:input');
    expect(statusGroupOf({ exchangeCount: 0 }, 'input')).toBe('status:input');
    expect(statusGroupOf(null, 'input')).toBe('status:input');
  });

  it('starts a sent chat at Building until a tool call names a phase, and files Exploring from an older engine there too', () => {
    expect(statusGroupOf({ exchangeCount: 0 }, 'working')).toBe('status:building');
    expect(statusGroupOf({ exchangeCount: 2 }, 'working')).toBe('status:building');
    expect(statusGroupOf(null, 'working')).toBe('status:building');
    expect(statusGroupOf({ exchangeCount: 2, phase: 'exploring' as never }, 'working')).toBe('status:building');
  });

  it('shows a phase group as live only while a chat in it works', () => {
    expect(groupActivityOf('status:building', ['error', 'working'])).toBe('building');
    expect(groupActivityOf('status:verifying', ['working'])).toBe('verifying');
    expect(groupActivityOf('status:building', ['error'])).toBeNull();
    expect(groupActivityOf('status:verifying', [])).toBeNull();
  });

  it('shows Watching as live while it holds a chat, and no other group at all', () => {
    expect(groupActivityOf('status:watching', [undefined])).toBe('watching');
    expect(groupActivityOf('status:watching', [])).toBeNull();
    for (const key of ['status:input', 'status:draft', 'status:done', 'date:today']) expect(groupActivityOf(key, ['working'])).toBeNull();
  });

  it('files a time under calendar-day date groups', () => {
    const now = new Date(2026, 9, 17, 10, 0).getTime();
    expect(dateGroupOf(new Date(2026, 9, 17, 0, 1).getTime(), now)).toBe('date:today');
    expect(dateGroupOf(new Date(2026, 9, 16, 23, 59).getTime(), now)).toBe('date:yesterday');
    expect(dateGroupOf(new Date(2026, 9, 12).getTime(), now)).toBe('date:week');
    expect(dateGroupOf(new Date(2026, 8, 25).getTime(), now)).toBe('date:month');
    expect(dateGroupOf(new Date(2026, 0, 1).getTime(), now)).toBe('date:older');
  });
});

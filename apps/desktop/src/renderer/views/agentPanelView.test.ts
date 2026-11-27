import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PANEL_VIEW, STATUS_GROUPS, activityAt, shownReplyAt, canReorder, compareCards, dateGroupOf, groupActivityOf, isDefaultView,
  parseAgentPanelView, statusGroupOf, statusWithSubagents, withSort, type SortableCard,
} from './agentPanelView.js';

const card = (title: string, updatedAt: number, createdAt: number, order?: number): SortableCard => ({ title, updatedAt, createdAt, order });

describe('agent panel view', () => {
  it('defaults to grouping by activity', () => {
    expect(DEFAULT_AGENT_PANEL_VIEW).toEqual({
      groupBy: 'status', sortBy: 'manual', direction: 'desc',
      showMetadata: true, showAutomations: true, showEmptyGroups: false,
      showModel: true, showContext: true, showPullRequests: true, showGit: true, showSubagents: true, showWindows: true, showUpdated: true,
      showComputer: true,
      showComputerIcons: true,
      clusterChatGroups: true,
    });
    expect(isDefaultView(DEFAULT_AGENT_PANEL_VIEW)).toBe(true);
    expect(isDefaultView({ ...DEFAULT_AGENT_PANEL_VIEW, showMetadata: false })).toBe(false);
  });

  it('reads a saved view and drops anything no longer valid', () => {
    expect(parseAgentPanelView(null)).toBe(DEFAULT_AGENT_PANEL_VIEW);
    expect(parseAgentPanelView('not json')).toBe(DEFAULT_AGENT_PANEL_VIEW);
    expect(parseAgentPanelView(JSON.stringify({ groupBy: 'project', sortBy: 'bogus', direction: 'asc', showMetadata: false, showProvider: false, showAutomations: 'yes' })))
      .toEqual({ ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'project', direction: 'asc', showMetadata: false });
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

  it('keeps a chat working, under Building, while its sub-agents work after its turn (#2840)', () => {
    const lifted = statusWithSubagents('done', ['working', 'done']);
    expect(lifted).toBe('working');
    expect(statusGroupOf({ exchangeCount: 2, phase: 'building' }, lifted)).toBe('status:building');
    expect(statusWithSubagents(undefined, ['working'])).toBe('working');
    // A sub-agent waiting on you still wins, and the chat's own state stands otherwise.
    expect(statusWithSubagents('working', ['input'])).toBe('input');
    expect(statusWithSubagents('error', ['working'])).toBe('error');
    expect(statusWithSubagents('done', ['done'])).toBe('done');
    expect(statusWithSubagents(undefined, [])).toBeUndefined();
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

  it('files a stopped chat under Watching while it has a background watcher, alongside armed watches', () => {
    expect(statusGroupOf({ exchangeCount: 2, activeWatchCount: 1, backgroundWatchCount: 1 }, undefined)).toBe('status:watching');
    expect(statusGroupOf({ exchangeCount: 2, activeWatchCount: 0, backgroundWatchCount: 1 }, undefined)).toBe('status:watching');
    expect(statusGroupOf({ exchangeCount: 2, backgroundWatchCount: 1 }, 'done')).toBe('status:watching');
    expect(statusGroupOf({ exchangeCount: 2, activeWatchCount: 0, backgroundWatchCount: 0 }, undefined)).toBe('status:done');
    expect(statusGroupOf({ exchangeCount: 2, phase: 'building', backgroundWatchCount: 1 }, 'working')).toBe('status:building');
    expect(statusGroupOf({ exchangeCount: 2, backgroundWatchCount: 1 }, 'input')).toBe('status:input');
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


describe('card detail preferences', () => {
  it('defaults empty groups off and preserves saved opt-ins and legacy metadata off', () => {
    expect(DEFAULT_AGENT_PANEL_VIEW.showEmptyGroups).toBe(false);
    expect(parseAgentPanelView('{"showEmptyGroups":true,"showMetadata":false}')).toMatchObject({ showEmptyGroups: true, showMetadata: false, showModel: true });
  });
  it('round trips independent choices, resetting missing or invalid fields only', () => {
    const view = { ...DEFAULT_AGENT_PANEL_VIEW, showModel: false, showContext: false, showPullRequests: false, showGit: false, showSubagents: false, showWindows: false, showUpdated: false };
    expect(parseAgentPanelView(JSON.stringify(view))).toEqual(view);
    expect(parseAgentPanelView('{"showModel":false,"showContext":"false","showUpdated":null}')).toEqual({ ...DEFAULT_AGENT_PANEL_VIEW, showModel: false });
    expect(isDefaultView(view)).toBe(false);
  });
});

describe('activityAt', () => {
  const day = 86_400_000;
  const old = { updatedAt: 1000 * day, lastReplyAt: 100 * day };
  const filed = { updatedAt: 1000 * day, lastReplyAt: 999 * day };

  it('dates an idle or done chat by the reply its card shows, not by a save that only filed it', () => {
    expect(activityAt(old, 'idle')).toBe(100 * day);
    expect(activityAt(old, 'done')).toBe(100 * day);
    expect(activityAt(old, undefined)).toBe(100 * day);
    const ordered = [old, filed].map((c) => ({ ...card('c', activityAt(c, 'idle'), 0) }));
    expect(ordered.sort(compareCards({ sortBy: 'updated', direction: 'desc' }))[0].updatedAt).toBe(999 * day);
  });

  it('uses the save time while the chat works or has no reply', () => {
    expect(activityAt(old, 'working')).toBe(1000 * day);
    expect(activityAt({ updatedAt: 5 }, 'idle')).toBe(5);
  });
});

describe('chats in a chat group, newest reply first', () => {
  // Real field shapes from the daemon's sessions: updatedAt is bumped by filing, lastReplyAt is the card's "x ago".
  const now = 1795675600000;
  const chat = (title: string, updatedAt: number, lastReplyAt: number) => ({ title, updatedAt, lastReplyAt, createdAt: 1, order: undefined as number | undefined });
  const five = [
    chat('handover', 1795675557524, 1795675415671),
    chat('side icons', 1795675407613, 1795077263414), // just dragged in: updatedAt = now
    chat('logic', 1795675404604, 1795068823458), // just dragged in
    chat('find rs', 1795675061986, 1795512757671),
    chat('feature', 1795673166750, 1795673166703),
  ];
  const titles = (view: Parameters<typeof compareCards>[0]) =>
    [...five].map((c) => ({ ...c, updatedAt: activityAt(c, 'done') })).sort(compareCards(view)).map((c) => c.title);

  it('orders by the time the card shows, in every sort that is by recency', () => {
    const want = ['handover', 'feature', 'find rs', 'side icons', 'logic'];
    expect(titles({ sortBy: 'updated', direction: 'desc' })).toEqual(want);
    expect(titles({ sortBy: 'manual', direction: 'desc' })).toEqual(want);
    expect(now - shownReplyAt(five[1], 'done')!).toBeGreaterThan(5 * 86_400_000);
  });

  it('keeps the card time and the sort key one value, with the save time only as a fallback', () => {
    for (const c of five) expect(activityAt(c, 'idle')).toBe(shownReplyAt(c, 'idle'));
    expect(shownReplyAt(five[0], 'working')).toBeUndefined();
    expect(activityAt({ updatedAt: 9 }, 'done')).toBe(9);
  });

  it('does not move a chat when it is filed again (updatedAt = now)', () => {
    const before = titles({ sortBy: 'updated', direction: 'desc' });
    five[4].updatedAt = now;
    expect(titles({ sortBy: 'updated', direction: 'desc' })).toEqual(before);
  });
});

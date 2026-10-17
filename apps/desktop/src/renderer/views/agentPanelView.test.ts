import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PANEL_VIEW, canReorder, compareCards, dateGroupOf, isDefaultView,
  parseAgentPanelView, statusGroupOf, withSort, type SortableCard,
} from './agentPanelView.js';

const card = (title: string, updatedAt: number, createdAt: number, order?: number): SortableCard => ({ title, updatedAt, createdAt, order });

describe('agent panel view', () => {
  it('defaults to the panel as it always was', () => {
    expect(DEFAULT_AGENT_PANEL_VIEW).toEqual({
      groupBy: 'project', sortBy: 'manual', direction: 'desc',
      showMetadata: true, showAutomations: true, showEmptyGroups: true,
    });
    expect(isDefaultView(DEFAULT_AGENT_PANEL_VIEW)).toBe(true);
    expect(isDefaultView({ ...DEFAULT_AGENT_PANEL_VIEW, showMetadata: false })).toBe(false);
  });

  it('reads a saved view and drops anything no longer valid', () => {
    expect(parseAgentPanelView(null)).toBe(DEFAULT_AGENT_PANEL_VIEW);
    expect(parseAgentPanelView('not json')).toBe(DEFAULT_AGENT_PANEL_VIEW);
    expect(parseAgentPanelView(JSON.stringify({ groupBy: 'status', sortBy: 'bogus', direction: 'asc', showMetadata: false, showAutomations: 'yes' })))
      .toEqual({ ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'status', direction: 'asc', showMetadata: false });
  });

  it('only lets cards be dragged into order where that order is what the panel shows', () => {
    expect(canReorder(DEFAULT_AGENT_PANEL_VIEW)).toBe(true);
    expect(canReorder({ ...DEFAULT_AGENT_PANEL_VIEW, sortBy: 'name' })).toBe(false);
    expect(canReorder({ ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'status' })).toBe(false);
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

  it('files a card under its status, idle when nothing is running', () => {
    expect(statusGroupOf('input')).toBe('status:input');
    expect(statusGroupOf(undefined)).toBe('status:idle');
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

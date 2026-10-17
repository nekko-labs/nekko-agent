import { describe, expect, it } from 'vitest';
import { findChats, finderAge } from './chatFinder.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16, 12);

describe('finderAge', () => {
  it('reads Today under a day, then days up to 30', () => {
    expect(finderAge(NOW - 5 * 60 * 1000, NOW)).toBe('Today');
    expect(finderAge(NOW - DAY, NOW)).toBe('1 day');
    expect(finderAge(NOW - 12 * DAY, NOW)).toBe('12 days');
    expect(finderAge(NOW - 30 * DAY, NOW)).toBe('30 days');
  });
  it('moves to whole months after 30 days', () => {
    expect(finderAge(NOW - 31 * DAY, NOW)).toBe('1 month');
    expect(finderAge(NOW - 59 * DAY, NOW)).toBe('1 month');
    expect(finderAge(NOW - 60 * DAY, NOW)).toBe('2 months');
    expect(finderAge(NOW - 400 * DAY, NOW)).toBe('13 months');
  });
  it('never goes negative for a clock skewed into the future', () => {
    expect(finderAge(NOW + DAY, NOW)).toBe('Today');
  });
});

const chat = (id: string, title: string, ageDays: number, extra: Partial<{ firstUserText: string; lastReplyText: string; incognito: boolean }> = {}) =>
  ({ id, title, updatedAt: NOW - ageDays * DAY, ...extra });

describe('findChats', () => {
  const sessions = [
    chat('old', 'Fix the login bug', 40),
    chat('new', 'Pull latest main', 0),
    chat('mid', 'Refactor sidebar', 3, { firstUserText: 'please fix the scroll bounce in the sidebar' }),
    chat('secret', 'Fix private thing', 1, { incognito: true }),
  ];

  it('lists the latest chats first when the query is empty', () => {
    expect(findChats(sessions, '').map((h) => h.session.id)).toEqual(['new', 'mid', 'old']);
  });
  it('puts title matches before body matches, newest first within each', () => {
    const hits = findChats(sessions, 'fix');
    expect(hits.map((h) => h.session.id)).toEqual(['old', 'mid']);
    expect(hits[0].snippet).toBeUndefined();
    expect(hits[1].snippet).toContain('fix the scroll bounce');
  });
  it('needs every word, in any order and case', () => {
    expect(findChats(sessions, 'SIDEBAR bounce').map((h) => h.session.id)).toEqual(['mid']);
    expect(findChats(sessions, 'sidebar login')).toEqual([]);
  });
  it('never surfaces incognito chats', () => {
    expect(findChats(sessions, 'private')).toEqual([]);
  });
  it('caps the list', () => {
    const many = Array.from({ length: 80 }, (_, i) => chat(String(i), 'chat ' + i, i));
    expect(findChats(many, '', 50)).toHaveLength(50);
  });
});

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@nekko-agent/shared';
import type { TranscriptRow } from './transcript.js';
import { findChatMatches, matchRanges, rowSearchText, searchPattern, startMatch, stepMatch } from './chatSearch.js';

const msg = (key: string, role: ChatMessage['role'], content: string): TranscriptRow => ({
  key, kind: 'msg', prUrls: [], message: { id: key, role, content, createdAt: 0 } as ChatMessage,
});
const count = (text: string, q: string) => matchRanges(text, searchPattern(q)!).length;

describe('whole-word, case-insensitive matching', () => {
  it('ignores case', () => {
    expect(count('Scroll scroll SCROLL sCrOlL', 'scroll')).toBe(4);
    expect(count('scroll', 'SCROLL')).toBe(1);
  });

  it('matches only the whole word', () => {
    expect(count('scroller autoscroll scrolled scroll_bar', 'scroll')).toBe(0);
    expect(count('scroll, (scroll) "scroll". scroll!', 'scroll')).toBe(4);
    expect(count('**scroll** `scroll` [scroll]', 'scroll')).toBe(3);
  });

  it('treats letters and digits of any script as word characters', () => {
    expect(count('café cafés', 'café')).toBe(1);
    expect(count('naïve naïveté', 'NAÏVE')).toBe(1);
    expect(count('v2 v22 v2.1', 'v2')).toBe(2);
    expect(count('日本 日本語', '日本')).toBe(1);
  });

  it('searches for regex characters literally', () => {
    expect(count('a.b axb', 'a.b')).toBe(1);
    expect(count('c++ is c++', 'c++')).toBe(2);
    expect(count('(x) [x]', '(x)')).toBe(1);
  });

  it('matches a phrase across any whitespace', () => {
    expect(count('jump to latest, Jump  to\nlatest', 'jump to latest')).toBe(2);
    expect(count('jump to latestly', 'jump to latest')).toBe(0);
  });

  it('finds nothing for an empty or blank query', () => {
    expect(searchPattern('')).toBeNull();
    expect(searchPattern('   ')).toBeNull();
    expect(findChatMatches([msg('a', 'user', 'anything')], '  ')).toEqual([]);
  });
});

describe('what a row shows', () => {
  it('searches user and assistant text, not tool output', () => {
    expect(rowSearchText(msg('a', 'user', 'hello'))).toBe('hello');
    expect(rowSearchText(msg('b', 'assistant', 'hi'))).toBe('hi');
    expect(rowSearchText(msg('c', 'tool', 'output'))).toBe('');
    expect(rowSearchText({ key: 'd', kind: 'stats', stats: {} } as unknown as TranscriptRow)).toBe('');
  });

  it('does not search link and image targets, which are not shown', () => {
    const row = msg('a', 'assistant', 'See [the guide](https://x.dev/scroll) and ![diagram](scroll.png)');
    expect(rowSearchText(row)).toBe('See [the guide] and diagram');
    expect(findChatMatches([row], 'scroll')).toEqual([]);
    expect(findChatMatches([row], 'guide')).toHaveLength(1);
  });

  it('searches the typed input of a skill message, as it is shown', () => {
    const row = msg('a', 'user', 'expanded template text');
    (row as { message: ChatMessage }).message.skill = { name: 'review', input: 'check scroll' } as ChatMessage['skill'];
    expect(rowSearchText(row)).toBe('check scroll');
  });
});

describe('ordering and stepping', () => {
  const rows = [msg('a', 'user', 'scroll once'), msg('b', 'tool', 'scroll'), msg('c', 'assistant', 'Scroll and scroll again')];

  it('lists every match top to bottom with its occurrence in the row', () => {
    expect(findChatMatches(rows, 'scroll')).toEqual([
      { rowKey: 'a', nth: 0 }, { rowKey: 'c', nth: 0 }, { rowKey: 'c', nth: 1 },
    ]);
  });

  it('wraps around both ends', () => {
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(1, 3, 1)).toBe(2);
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });

  it('always starts at the first match (1 of N), or none', () => {
    expect(startMatch(findChatMatches(rows, 'scroll'))).toBe(0);
    expect(startMatch([])).toBe(-1);
  });
});

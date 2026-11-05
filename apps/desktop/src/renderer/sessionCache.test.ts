import { beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@nekko-agent/shared';
import {
  MAX_BYTES,
  MAX_CHATS,
  __resetSessionCache,
  cachedBytes,
  cachedSessionIds,
  getCachedSession,
  holdTranscript,
  putCachedSession,
  transcriptBytes,
  transcriptsLoaded,
} from './sessionCache.js';

const chat = (id: string, chars = 10): Session => ({
  id,
  title: id,
  messages: [{ id: `${id}_m`, role: 'assistant', content: 'x'.repeat(chars), createdAt: 0 }],
  createdAt: 0,
  updatedAt: 0,
});

describe('first transcript holds', () => {
  it('settles at once with nothing on screen, and only after the last hold is released', async () => {
    await transcriptsLoaded();
    const first = holdTranscript();
    const second = holdTranscript();
    let settled = false;
    const waiting = transcriptsLoaded().then(() => { settled = true; });
    first();
    first(); // a pane can release from both its load and its unmount
    await Promise.resolve();
    expect(settled).toBe(false);
    second();
    await waiting;
    expect(settled).toBe(true);
  });
});

describe('session cache', () => {
  beforeEach(() => __resetSessionCache());

  it('serves what it was given, newest copy first', () => {
    putCachedSession(chat('a'));
    const fresh = { ...chat('a'), title: 'renamed' };
    putCachedSession(fresh);
    expect(getCachedSession('a')).toBe(fresh);
    expect(getCachedSession('missing')).toBeUndefined();
  });

  it(`keeps at most ${MAX_CHATS} chats, dropping the least recently used`, () => {
    for (let i = 0; i < MAX_CHATS; i++) putCachedSession(chat(`c${i}`));
    getCachedSession('c0'); // touched, so c1 is now the oldest
    putCachedSession(chat('new'));
    const ids = cachedSessionIds();
    expect(ids).toHaveLength(MAX_CHATS);
    expect(ids).toContain('c0');
    expect(ids).not.toContain('c1');
    expect(ids[ids.length - 1]).toBe('new');
  });

  it('holds its text under the byte budget', () => {
    const big = Math.floor(MAX_BYTES / 2 / 2) - 1_000; // just under half the budget each
    putCachedSession(chat('a', big));
    putCachedSession(chat('b', big));
    expect(cachedSessionIds()).toEqual(['a', 'b']);
    putCachedSession(chat('c', big));
    expect(cachedSessionIds()).toEqual(['b', 'c']);
    expect(cachedBytes()).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('keeps the chat just opened even when it alone is over budget', () => {
    putCachedSession(chat('small'));
    putCachedSession(chat('huge', MAX_BYTES));
    expect(cachedSessionIds()).toEqual(['huge']);
    expect(cachedBytes()).toBe(transcriptBytes(chat('huge', MAX_BYTES)));
  });
});

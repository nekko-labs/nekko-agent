import { describe, expect, it } from 'vitest';
import { spellingWordsAt } from './composerSpelling.js';

describe('composer spelling word boundaries', () => {
  it('returns the targeted occurrence without surrounding Markdown or punctuation', () => {
    expect(spellingWordsAt('recieve, **recieve**.', 14)).toEqual([{ word: 'recieve', start: 11, end: 18 }]);
  });

  it('accepts either caret edge of the word', () => {
    const hit = [{ word: 'recieve', start: 1, end: 8 }];
    expect(spellingWordsAt('(recieve)', 1)).toEqual(hit);
    expect(spellingWordsAt('(recieve)', 8)).toEqual(hit);
    expect(spellingWordsAt('(recieve)', 9)).toEqual([]);
  });

  it('uses UTF-16 editor offsets and keeps diacritics and apostrophes', () => {
    expect(spellingWordsAt('🙂 l’e\u0301té', 5)).toEqual([{ word: 'l’e\u0301té', start: 3, end: 10 }]);
  });

  it('ignores blank space, numbers, and identifiers', () => {
    expect(spellingWordsAt('   ', 1)).toEqual([]);
    expect(spellingWordsAt('1234', 2)).toEqual([]);
    expect(spellingWordsAt('snake_case', 7)).toEqual([]);
  });
});

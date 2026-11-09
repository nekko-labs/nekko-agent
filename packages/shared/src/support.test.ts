import { describe, expect, it } from 'vitest';
import { STAR_ASK_START, countStarAskPrompt, markStarAskShown, parseStarAsk, starAskDue, stopStarAsk, type StarAskState } from './support.js';

const after = (n: number, from: StarAskState = STAR_ASK_START) => {
  let s = from;
  for (let i = 0; i < n; i++) s = countStarAskPrompt(s);
  return s;
};

describe('GitHub star ask', () => {
  it('asks first after the 10th finished prompt, not before', () => {
    expect(starAskDue(after(9))).toBe(false);
    expect(starAskDue(after(10))).toBe(true);
  });

  it('asks a second time at 50, then never again', () => {
    const first = markStarAskShown(after(10));
    expect(starAskDue(after(39, first))).toBe(false);
    const second = after(40, first);
    expect(second.prompts).toBe(50);
    expect(starAskDue(second)).toBe(true);
    const done = markStarAskShown(second);
    expect(starAskDue(after(500, done))).toBe(false);
  });

  it('never shows both asks back to back when the first comes late', () => {
    const late = markStarAskShown(after(60));
    expect(late.asked).toBe(2);
    expect(starAskDue(after(1, late))).toBe(false);
  });

  it('stops for good on a star or "Don\'t ask again"', () => {
    expect(starAskDue(stopStarAsk(after(10)))).toBe(false);
    expect(starAskDue(after(40, stopStarAsk(markStarAskShown(after(10)))))).toBe(false);
  });

  it('reads stored state defensively', () => {
    expect(parseStarAsk(null)).toEqual(STAR_ASK_START);
    expect(parseStarAsk('not json')).toEqual(STAR_ASK_START);
    expect(parseStarAsk('{"prompts":-3,"asked":"2","stopped":"yes"}')).toEqual(STAR_ASK_START);
    expect(parseStarAsk('{"prompts":12.7,"asked":1,"stopped":true}')).toEqual({ prompts: 12, asked: 1, stopped: true });
  });
});

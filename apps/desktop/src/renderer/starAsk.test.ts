import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStarAsk, starAskAfterReply, stopStarAsking } from './starAsk.js';

function storage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  vi.stubGlobal('localStorage', { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe('GitHub star ask storage', () => {
  it('carries the card on the 10th and 50th finished prompt only', () => {
    storage();
    const due = Array.from({ length: 120 }, () => starAskAfterReply());
    expect(due.flatMap((d, i) => (d ? [i + 1] : []))).toEqual([10, 50]);
  });

  it('never asks again once stopped', () => {
    storage();
    for (let i = 0; i < 9; i++) starAskAfterReply();
    stopStarAsking();
    expect(Array.from({ length: 100 }, () => starAskAfterReply()).some(Boolean)).toBe(false);
    expect(readStarAsk().stopped).toBe(true);
  });

  it('keeps the count in this profile under one key', () => {
    const data = storage();
    starAskAfterReply();
    expect(JSON.parse(data['nekko.star-ask'])).toEqual({ prompts: 1, asked: 0 });
  });

  it('never asks, and never throws, without storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(Array.from({ length: 60 }, () => starAskAfterReply()).some(Boolean)).toBe(false);
    expect(() => stopStarAsking()).not.toThrow();
  });
});

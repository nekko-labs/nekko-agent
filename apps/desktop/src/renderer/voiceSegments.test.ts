import { describe, expect, it } from 'vitest';
import { createSegmentQueue } from './voiceSegments.js';

const wav = (n: number) => [n];
const later = (text: string, ms: number) => new Promise<string>(r => setTimeout(() => r(text), ms));

describe('segment queue', () => {
  it('applies results in push order even when a later one finishes first', async () => {
    const applied: string[] = [];
    const q = createSegmentQueue(w => (w[0] === 1 ? later('A', 50) : Promise.resolve('B')), t => applied.push(t));
    q.push(wav(1)); q.push(wav(2));
    await q.drain();
    expect(applied).toEqual(['A', 'B']);
  });
  it('skips a failed or empty transcription without blocking later ones', async () => {
    const applied: string[] = [];
    const q = createSegmentQueue(w => (w[0] === 1 ? Promise.reject(new Error('boom')) : w[0] === 2 ? Promise.resolve('  ') : Promise.resolve('C')), t => applied.push(t));
    q.push(wav(1)); q.push(wav(2)); q.push(wav(3));
    await q.drain();
    expect(applied).toEqual(['C']);
  });
  it('drain resolves after the last apply and immediately when idle', async () => {
    const applied: string[] = [];
    const q = createSegmentQueue(() => later('X', 20), t => applied.push(t));
    await q.drain();
    q.push(wav(1));
    await q.drain();
    expect(applied).toEqual(['X']);
  });
});

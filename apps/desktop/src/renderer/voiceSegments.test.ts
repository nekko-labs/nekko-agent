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

describe('segment queue failures', () => {
  it('keeps applying later segments when apply throws, and drain still resolves', async () => {
    const applied: string[] = [];
    const q = createSegmentQueue(w => Promise.resolve(w[0] === 1 ? 'bad' : 'good'), t => { if (t === 'bad') throw new Error('apply failed'); applied.push(t); });
    q.push(wav(1)); q.push(wav(2));
    await q.drain();
    expect(applied).toEqual(['good']);
  });
  it('treats a transcribe that throws synchronously like a rejection', async () => {
    const applied: string[] = [];
    const q = createSegmentQueue(w => { if (w[0] === 1) throw new Error('sync'); return Promise.resolve('D'); }, t => applied.push(t));
    q.push(wav(1)); q.push(wav(2));
    await q.drain();
    expect(applied).toEqual(['D']);
  });
  it('waits for an async apply before applying the next segment', async () => {
    const order: string[] = [];
    const q = createSegmentQueue(w => Promise.resolve(String(w[0])), async t => { if (t === '1') await later('', 20); order.push(t); });
    q.push(wav(1)); q.push(wav(2));
    await q.drain();
    expect(order).toEqual(['1', '2']);
  });
});

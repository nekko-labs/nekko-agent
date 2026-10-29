import { describe, expect, it } from 'vitest';
import { keepSegment, pcmWav, PRE_ROLL_SECONDS, shouldCut, trimPreRoll } from './voiceCapture.js';

describe('local PCM recording', () => {
  it('encodes mono 16kHz PCM without an external converter', () => {
    const bytes = pcmWav(new Float32Array(48000).fill(0.5), 48000);
    const v = new DataView(Uint8Array.from(bytes).buffer);
    expect(bytes.length).toBe(32044);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getInt16(44, true)).toBe(16383);
  });
  it('clamps excessive amplitude', () => {
    const v = new DataView(Uint8Array.from(pcmWav(new Float32Array([-2, 2]), 16000)).buffer);
    expect(v.getInt16(44, true)).toBe(-32768);
    expect(v.getInt16(46, true)).toBe(32767);
  });
});

describe('segment cut decision', () => {
  const base = { speech: true, silentMs: 0, silenceMs: 1200, seconds: 1, maxSeconds: 30 };
  it('cuts after silence following speech, clamping silenceMs to 300..5000', () => {
    expect(shouldCut({ ...base, silentMs: 1300 })).toBe(true);
    expect(shouldCut({ ...base, silentMs: 1100 })).toBe(false);
    expect(shouldCut({ ...base, silentMs: 400, silenceMs: 10 })).toBe(true);
    expect(shouldCut({ ...base, silentMs: 4000, silenceMs: 99999 })).toBe(false);
  });
  it('never cuts on silence before speech, but always at the cap', () => {
    expect(shouldCut({ ...base, speech: false, silentMs: 9000 })).toBe(false);
    expect(shouldCut({ ...base, speech: false, seconds: 30 })).toBe(true);
    expect(shouldCut({ ...base, seconds: 29.9 })).toBe(false);
  });
  it('drops segments under 0.25 s or without speech', () => {
    expect(keepSegment(true, 0.24)).toBe(false);
    expect(keepSegment(true, 0.25)).toBe(true);
    expect(keepSegment(false, 30)).toBe(false);
  });
});

describe('pre-roll before speech', () => {
  const chunk = (n: number, fill = 0) => new Float32Array(n).fill(fill);
  it('keeps only the newest chunks that cover the 0.3 s pre-roll', () => {
    const chunks = Array.from({ length: 50 }, (_, i) => chunk(1000, i));
    const kept = trimPreRoll(chunks, 10000);
    expect(PRE_ROLL_SECONDS).toBe(0.3);
    expect(kept.map(c => c[0])).toEqual([47, 48, 49]);
    expect(kept.reduce((n, c) => n + c.length, 0)).toBeGreaterThanOrEqual(3000);
  });
  it('leaves a buffer already shorter than the pre-roll alone', () => {
    const chunks = [chunk(1000), chunk(1000)];
    expect(trimPreRoll(chunks, 10000)).toEqual(chunks);
    expect(trimPreRoll([], 10000)).toEqual([]);
  });
  it('an hour of idle never reaches the 30 s cap', () => {
    let chunks: Float32Array[] = [];
    for (let i = 0; i < 3600 * 12; i++) chunks = trimPreRoll([...chunks, chunk(4096)], 48000);
    const seconds = chunks.reduce((n, c) => n + c.length, 0) / 48000;
    expect(seconds).toBeLessThan(0.5);
    expect(shouldCut({ speech: false, silentMs: 3_600_000, seconds, maxSeconds: 30 })).toBe(false);
  });
});

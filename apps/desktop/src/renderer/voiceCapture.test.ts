import { describe, expect, it } from 'vitest';
import { keepSegment, pcmWav, shouldCut } from './voiceCapture.js';

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

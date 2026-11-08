import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepSegment, pcmWav, PRE_ROLL_SECONDS, shouldCut, startVoiceCapture, trimPreRoll } from './voiceCapture.js';

afterEach(() => { vi.unstubAllGlobals(); });

function audioSetup(failure?: string, cleanupFails = false) {
  const error = new Error(`Failed ${failure}`);
  const failAt = (step: string) => { if (failure === step) throw error; };
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks };
  const source = { connect: vi.fn(() => failAt('source.connect')), disconnect: vi.fn() };
  const processor = { connect: vi.fn(() => failAt('processor.connect')), disconnect: vi.fn(), onaudioprocess: null as null | ((event: any) => void) };
  const context = {
    sampleRate: 16000, destination: {},
    createMediaStreamSource: vi.fn(() => { failAt('source'); return source; }),
    createScriptProcessor: vi.fn(() => { failAt('processor'); return processor; }),
    resume: vi.fn(async () => { failAt('resume'); }), close: vi.fn(async () => {}),
  };
  if (cleanupFails) {
    source.disconnect.mockImplementation(() => { throw new Error('disconnect failed'); });
    tracks[0].stop.mockImplementation(() => { throw new Error('stop failed'); });
    context.close.mockRejectedValue(new Error('close failed'));
  }
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.stubGlobal('AudioContext', class { constructor() { failAt('constructor'); return context; } });
  return { error, tracks, source, processor, context };
}

describe('capture setup and teardown', () => {
  it.each(['constructor', 'source', 'processor', 'source.connect', 'processor.connect', 'resume'])('releases all acquired resources when %s fails', async failure => {
    const audio = audioSetup(failure);
    await expect(startVoiceCapture({ onLevel: vi.fn(), onSilence: vi.fn() })).rejects.toBe(audio.error);
    for (const track of audio.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(audio.context.close).toHaveBeenCalledTimes(failure === 'constructor' ? 0 : 1);
    expect(audio.source.disconnect).toHaveBeenCalledTimes(['constructor', 'source'].includes(failure) ? 0 : 1);
    expect(audio.processor.disconnect).toHaveBeenCalledTimes(['constructor', 'source', 'processor'].includes(failure) ? 0 : 1);
    expect(audio.processor.onaudioprocess).toBeNull();
  });
  it('preserves the setup error and continues cleanup when disconnect, track stop and close fail', async () => {
    const audio = audioSetup('resume', true);
    await expect(startVoiceCapture({ onLevel: vi.fn(), onSilence: vi.fn() })).rejects.toBe(audio.error);
    expect(audio.processor.disconnect).toHaveBeenCalledOnce();
    for (const track of audio.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(audio.context.close).toHaveBeenCalledOnce();
    expect(audio.processor.onaudioprocess).toBeNull();
  });
  it.each(['stop', 'abort'] as const)('%s releases resources only once and prevents late audio callbacks', async method => {
    const audio = audioSetup();
    const onLevel = vi.fn();
    const local = await startVoiceCapture({ onLevel, onSilence: vi.fn() });
    const process = audio.processor.onaudioprocess!;
    process({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) } });
    const result = local[method]();
    if (method === 'stop') expect(result).toHaveLength(44 + 4096 * 2);
    local.abort(); expect(local.stop()).toEqual([]);
    process({ inputBuffer: { getChannelData: () => { throw new Error('must not read late audio'); } } });
    expect(onLevel).toHaveBeenCalledOnce();
    expect(audio.source.disconnect).toHaveBeenCalledOnce();
    expect(audio.processor.disconnect).toHaveBeenCalledOnce();
    for (const track of audio.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(audio.context.close).toHaveBeenCalledOnce();
  });
  it('still flushes speech tails and drops silent tails in segment mode', async () => {
    const audio = audioSetup();
    const local = await startVoiceCapture({ onLevel: vi.fn(), onSilence: vi.fn(), onSegment: vi.fn() });
    audio.processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) } });
    expect(local.stop()).toHaveLength(44 + 4096 * 2);
    const quiet = await startVoiceCapture({ onLevel: vi.fn(), onSilence: vi.fn(), onSegment: vi.fn() });
    audio.processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(quiet.stop()).toEqual([]);
  });
});

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

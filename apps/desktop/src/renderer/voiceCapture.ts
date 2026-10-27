export function pcmWav(samples: Float32Array, sampleRate: number): number[] {
  const length = Math.floor(samples.length * 16000 / sampleRate);
  const b = new ArrayBuffer(44 + length * 2); const v = new DataView(b);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); v.setUint32(4, b.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) { const x = Math.max(-1, Math.min(1, samples[Math.floor(i * sampleRate / 16000)] ?? 0)); v.setInt16(44 + i * 2, x * (x < 0 ? 32768 : 32767), true); }
  return Array.from(new Uint8Array(b));
}

export const SEGMENT_MAX_SECONDS = 30; const CAPTURE_MAX_SECONDS = 60; const MIN_SEGMENT_SECONDS = 0.25;

// Cut when speech has been followed by silenceMs (clamped 300..5000) of quiet, or the audio hit the cap.
export function shouldCut(o: { speech: boolean; silentMs: number; silenceMs?: number; seconds: number; maxSeconds: number }): boolean {
  return (o.speech && o.silentMs > Math.max(300, Math.min(5000, o.silenceMs ?? 1200))) || o.seconds >= o.maxSeconds;
}

// A segment with no speech (a capped silent stretch) or under 0.25 s is not worth transcribing.
export const keepSegment = (speech: boolean, seconds: number): boolean => speech && seconds >= MIN_SEGMENT_SECONDS;

const concat = (chunks: Float32Array[], count: number) => {
  const all = new Float32Array(count); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
};

export async function startVoiceCapture(options: { deviceId?: string; sensitivity?: number; silenceMs?: number; onLevel: (n: number) => void; onSilence: () => void; onSegment?: (wav: number[]) => void }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: options.deviceId ? { exact: options.deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  let context: AudioContext;
  try { context = new AudioContext(); } catch (e) { stream.getTracks().forEach(t => t.stop()); throw e; }
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  let chunks: Float32Array[] = []; let count = 0; let speech = false; let lastSpeech = performance.now(); let ended = false;
  const threshold = 0.05 - Math.max(0, Math.min(100, options.sensitivity ?? 60)) * 0.00045;
  processor.onaudioprocess = (event) => {
    if (ended) return;
    const data = new Float32Array(event.inputBuffer.getChannelData(0)); chunks.push(data); count += data.length;
    const rms = Math.sqrt(data.reduce((n, x) => n + x * x, 0) / data.length); options.onLevel(Math.min(1, rms * 8));
    if (rms > threshold) { speech = true; lastSpeech = performance.now(); }
    const seconds = count / context.sampleRate;
    if (!shouldCut({ speech, silentMs: performance.now() - lastSpeech, silenceMs: options.silenceMs, seconds, maxSeconds: options.onSegment ? SEGMENT_MAX_SECONDS : CAPTURE_MAX_SECONDS })) return;
    if (!options.onSegment) { options.onSilence(); return; }
    if (keepSegment(speech, seconds)) options.onSegment(pcmWav(concat(chunks, count), context.sampleRate));
    chunks = []; count = 0; speech = false; lastSpeech = performance.now();
  };
  source.connect(processor); processor.connect(context.destination);
  try { await context.resume(); }
  catch (e) { source.disconnect(); processor.disconnect(); stream.getTracks().forEach(t => t.stop()); await context.close(); throw e; }
  const stop = () => {
    if (ended) return [];
    ended = true; processor.onaudioprocess = null; source.disconnect(); processor.disconnect(); stream.getTracks().forEach(t => t.stop()); void context.close();
    return pcmWav(concat(chunks, count), context.sampleRate);
  };
  return { stop, abort: () => { stop(); } };
}

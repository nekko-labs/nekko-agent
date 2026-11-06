// Whisper writes non-speech as bracketed or parenthesised tags ("[BLANK_AUDIO]", "[Music]",
// "(keyboard clicking)"), the same rule the Android app applies; none of them are words.
const ANNOTATION = /\[[^\]\n]{1,40}]|\([^)\n]{1,40}\)/g;
const onlyAnnotations = (text: string) => !text.replace(ANNOTATION, '').trim();

// The engine transcribes one recording at a time (nekkod refuses a second while one runs),
// so segments are transcribed one after another and applied strictly in push order.
// A failed transcription is reported and skipped; a failed apply is skipped. Neither blocks the ones after it.
export function createSegmentQueue(transcribe: (wav: number[]) => Promise<string>, apply: (text: string) => unknown, onError: (error: unknown) => void = () => {}) {
  let transcribing: Promise<unknown> = Promise.resolve();
  let tail: Promise<void> = Promise.resolve();
  return {
    push(wav: number[]) {
      const result = transcribing.then(() => transcribe(wav));
      transcribing = result.catch(() => {});
      tail = tail.then(async () => {
        let text: string;
        try { text = (await result).trim(); } catch (e) { onError(e); return; }
        if (text && !onlyAnnotations(text)) await apply(text);
      }).catch(() => {});
    },
    drain: () => tail,
  };
}

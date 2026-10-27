// Transcribes segments concurrently but applies the text strictly in push order.
// A failed transcription or apply skips that segment and never blocks the ones after it.
export function createSegmentQueue(transcribe: (wav: number[]) => Promise<string>, apply: (text: string) => unknown) {
  let tail: Promise<void> = Promise.resolve();
  return {
    push(wav: number[]) {
      const result = new Promise<string>(resolve => resolve(transcribe(wav))).catch(() => '');
      tail = tail.then(async () => {
        const text = (await result).trim();
        if (text) await apply(text);
      }).catch(() => {});
    },
    drain: () => tail,
  };
}

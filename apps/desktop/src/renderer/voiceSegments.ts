// Transcribes segments concurrently but applies the text strictly in push order.
export function createSegmentQueue(transcribe: (wav: number[]) => Promise<string>, apply: (text: string) => void) {
  let tail: Promise<void> = Promise.resolve();
  return {
    push(wav: number[]) {
      const result = transcribe(wav).catch(() => '');
      tail = tail.then(async () => { const text = (await result).trim(); if (text) apply(text); });
    },
    drain: () => tail,
  };
}

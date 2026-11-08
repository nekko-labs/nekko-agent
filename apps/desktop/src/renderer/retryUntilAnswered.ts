const RETRY_MS = 5000;

/**
 * Run `attempt` until it resolves, trying again after a rejection. For the
 * reads a window needs once: the engine may still be starting, and nothing else
 * asks again, so a window would stay empty until something happened to re-read
 * them. `retried` is false only on the first try. Returns a stop.
 */
export function retryUntilAnswered(attempt: (retried: boolean) => Promise<unknown>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (retried: boolean) => {
    attempt(retried).catch(() => {
      if (!stopped) timer = setTimeout(() => run(true), RETRY_MS);
    });
  };
  run(false);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

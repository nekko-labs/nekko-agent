/** Keep sidebar/wall watch counts fresh even when their ChatPane is unmounted. */
export function startSessionSummaryRefresh(refresh: () => Promise<void>): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let stopped = false;
  const flush = async () => {
    timer = undefined;
    if (stopped || running) return;
    pending = false;
    running = true;
    try { await refresh(); } catch { /* The next event or manual refresh catches up. */ }
    finally {
      running = false;
      if (!stopped && pending && timer === undefined) timer = setTimeout(() => void flush(), 100);
    }
  };
  const off = window.nekko.onAgentEvent((event) => {
    if (!['done', 'error', 'session_meta'].includes(event.type)) return;
    pending = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 100);
  });
  return () => { stopped = true; off(); if (timer !== undefined) clearTimeout(timer); };
}

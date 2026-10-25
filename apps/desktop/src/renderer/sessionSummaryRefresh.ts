/** Keep sidebar/wall watch counts fresh even when their ChatPane is unmounted. */
export function startSessionSummaryRefresh(refresh: () => Promise<void>): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = window.nekko.onAgentEvent((event) => {
    if (!['done', 'error', 'session_meta'].includes(event.type)) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().catch(() => {});
    }, 100);
  });
  return () => { off(); if (timer !== undefined) clearTimeout(timer); };
}

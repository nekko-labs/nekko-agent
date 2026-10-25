import { useEffect, useState } from 'react';
import { refreshAgentWatches, useAgentWatches, watchClock } from '../agentWatches.js';
import { WatchIcon } from './agent-console/WatchRow.js';

/** Always visible with the composer, independent of transcript virtualization. */
export function ActiveWatchChips({ sessionId, owner }: { sessionId: string; owner?: string }) {
  const watches = useAgentWatches(sessionId).filter(w => w.status === 'active');
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!watches.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [watches.length]);
  if (!watches.length && !error) return null;
  return <div className="flex flex-wrap gap-2 border-b border-line px-3 py-2 text-[12px]" data-active-watch-chips>
    {watches.map(w => {
      const clock = watchClock({ action: 'create', kind: w.kind, prompt: '' }, w, now);
      return <details key={w.id} className="min-w-0 max-w-full rounded-lg border border-line px-2 py-1">
        <summary className="flex cursor-pointer flex-wrap items-center gap-1.5" title={clock?.title}>
          <WatchIcon />{owner && <span className="max-w-40 truncate" title={owner}>{owner} ·</span>}<span>{w.kind === 'pr' ? 'PR watcher' : 'Timer watcher'}</span>
          <span>{clock?.text ?? 'Status unavailable'}</span>
        </summary>
        <div className="space-y-1 py-2">
          <div className="break-all text-ink-faint">Watch {w.id}</div>
          {w.url && /^https:\/\/github\.com\//i.test(w.url) && <a href={w.url} target="_blank" rel="noreferrer" className="underline">Open pull request</a>}
          <p>{clock?.title}</p>
          <button type="button" className="btn btn-outline text-[12px]" disabled={busy !== null} onClick={async () => {
            setBusy(w.id); setError(null);
            try { await window.nekko.cancelAgentWatch(sessionId, w.id); refreshAgentWatches(sessionId); }
            catch (e) { setError(`Could not cancel watcher: ${String(e)}`); }
            finally { setBusy(null); }
          }}>{busy === w.id ? 'Cancelling…' : 'Cancel watcher'}</button>
        </div>
      </details>;
    })}
    {error && <p role="alert">{error}</p>}
  </div>;
}

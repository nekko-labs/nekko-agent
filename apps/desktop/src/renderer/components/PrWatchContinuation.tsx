import { useState } from 'react';
import type { PrInfo } from '@nekko-agent/shared';
import { useAgentWatches, fmtSpan } from '../agentWatches.js';
import { prWatchPrompt, unwatchedPrs } from '../prWatchContinuation.js';
import { WatchIcon } from './agent-console/WatchRow.js';

/** User consent starts a normal agent turn; the durable scheduler remains the single source of truth. */
export function PrWatchContinuation({ sessionId, replyId, prs, eligible, onContinue }: {
  sessionId: string; replyId: string; prs: PrInfo[]; eligible: boolean;
  onContinue: (prompt: string) => Promise<void>;
}) {
  const watches = useAgentWatches(sessionId);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = watches.filter(w => w.status === 'active');
  const offers = eligible ? unwatchedPrs(prs, watches).filter(pr => !dismissed.includes(`${replyId}:${pr.url}`)) : [];
  if (!active.length && !offers.length && !error) return null;
  return <div className="space-y-2 py-2 text-[12px]" data-pr-watch-continuation>
    {active.map(w => <div key={w.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2" role="status">
      <WatchIcon /><span className="font-medium">Watcher active</span>
      {w.url && <a href={w.url} target="_blank" rel="noreferrer" className="underline">PR #{w.url.split('/').at(-1)}</a>}
      <span className="text-ink-faint">{w.pending ? 'Ready to continue when chat is free' : `Wakes on change or by ${new Date(w.deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span>
      {w.failures > 0 && <span className="text-ink-faint" title={w.lastError}>Polling retry · {fmtSpan(Math.max(0, w.nextPollAt - Date.now()))}</span>}
    </div>)}
    {offers.map(pr => <div key={pr.url} className="flex flex-wrap items-center gap-2" data-pr-watch-offer>
      <span className="text-ink-faint">PR #{pr.number} is still open.</span>
      <button type="button" className="btn btn-primary text-[12px]" disabled={!!starting} onClick={async () => {
        setStarting(pr.url); setError(null);
        try { await onContinue(prWatchPrompt(pr.url)); }
        catch (e) { setError(`Could not start watcher: ${String(e)}`); }
        finally { setStarting(null); }
      }}>{starting === pr.url ? 'Requesting watcher…' : 'Watch CI and merge when passing'}</button>
      <button type="button" className="btn btn-outline text-[12px]" disabled={!!starting} onClick={() => setDismissed(v => [...v, `${replyId}:${pr.url}`])}>Skip</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}

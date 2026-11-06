import { useState } from 'react';
import type { PrInfo } from '@nekko-agent/shared';
import { useAgentWatches } from '../agentWatches.js';
import { prWatchPrompt, unwatchedPrs } from '../prWatchContinuation.js';

/** User consent starts a normal agent turn; the durable scheduler remains the single source of truth. */
export function PrWatchContinuation({ sessionId, replyId, prs, eligible, onContinue }: {
  sessionId: string; replyId: string; prs: PrInfo[]; eligible: boolean;
  onContinue: (prompt: string) => Promise<void>;
}) {
  const watches = useAgentWatches(sessionId);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offers = eligible ? unwatchedPrs(prs, watches).filter(pr => !dismissed.includes(`${replyId}:${pr.url}`)) : [];
  if (!offers.length && !error) return null;
  return <div className="space-y-2 py-2 text-xs" data-pr-watch-continuation>
    {offers.map(pr => <div key={pr.url} className="flex flex-wrap items-center gap-2" data-pr-watch-offer>
      <span className="text-ink-faint">PR #{pr.number} is still open.</span>
      <button type="button" className="btn btn-primary text-xs" disabled={!!starting} onClick={async () => {
        setStarting(pr.url); setError(null);
        try { await onContinue(prWatchPrompt(pr.url)); }
        catch (e) { setError(`Could not start watcher: ${String(e)}`); }
        finally { setStarting(null); }
      }}>{starting === pr.url ? 'Requesting watcher…' : 'Watch CI and merge when passing'}</button>
      <button type="button" className="btn btn-outline text-xs" disabled={!!starting} onClick={() => setDismissed(v => [...v, `${replyId}:${pr.url}`])}>Skip</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}

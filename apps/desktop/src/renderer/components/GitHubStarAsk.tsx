import React, { useEffect, useState } from 'react';
import { SUPPORT_REPOSITORY_URL } from '@nekko-agent/shared';
import { CloseIcon, StarIcon } from '../icons.js';
import { stopStarAsking } from '../starAsk.js';
import { refreshSupportStar, useSupportStar } from '../supportStar.js';
import { StarryNekko } from './StarryNekko.js';

/**
 * The in-chat ask under a finished reply (spec/platform/github-star-ask.md).
 * With the GitHub connector connected the star is added here in one click, the
 * same `support:star` action Settings uses; otherwise it opens the repository.
 * Someone GitHub already shows as a stargazer never sees it.
 */
export function GitHubStarAsk({ onClose }: { onClose: () => void }) {
  const { status, busy, celebrating } = useSupportStar();
  // What this card did: nothing yet, starred in the app, or opened GitHub.
  const [acted, setActed] = useState<'none' | 'starring' | 'opened'>('none');
  const [openError, setOpenError] = useState(false);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let live = true;
    void refreshSupportStar().finally(() => { if (live) setChecked(true); });
    return () => { live = false; };
  }, []);
  const starred = status?.state === 'starred';
  // Already a stargazer before this card asked: say nothing and stop asking.
  useEffect(() => {
    if (checked && starred && acted === 'none') { stopStarAsking(); onClose(); }
  }, [checked, starred, acted, onClose]);

  const finish = (forever: boolean) => { if (forever) stopStarAsking(); onClose(); };
  const star = async () => {
    stopStarAsking();
    if (status?.state === 'not-starred') {
      setActed('starring');
      await refreshSupportStar(true);
      return;
    }
    setOpenError(false);
    try { await window.nekko.openPath(SUPPORT_REPOSITORY_URL); setActed('opened'); } catch { setOpenError(true); }
  };

  // Hold back until GitHub has answered, so a stargazer never sees it flash.
  if (!checked || !status || (starred && acted === 'none')) return null;

  const thanked = (acted === 'starring' && starred) || acted === 'opened';
  const failed = acted === 'starring' && !busy && !starred;
  return (
    <section className="fade-in mb-2 rounded-xl border px-3 py-2.5" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
      aria-label="Star Nekko Agent on GitHub" data-testid="github-star-ask">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 shrink-0 ${celebrating ? 'support-star-celebrate' : ''}`}>
          {thanked ? <StarryNekko size={28} /> : <StarIcon className="h-5 w-5 text-accent" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink" role="status">
            {thanked
              ? acted === 'opened' ? 'Thank you! Nekko is happy you’re here.' : `Thank you, @${status.login}! Nekko is happy you’re here.`
              : 'Nekko Agent is open source'}
          </p>
          <p className="mt-0.5 text-xs text-ink-soft">
            {thanked
              ? acted === 'opened' ? 'GitHub opened in your browser. Starring there takes one click.' : 'Your star is on GitHub.'
              : failed ? status.reason ?? 'Couldn’t add the star. You can still star on GitHub.'
                : 'If it helps you, a star on GitHub helps more people find it.'}
          </p>
          {!thanked && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-primary shrink-0 px-3 py-0.5 text-2xs" disabled={busy} data-testid="star-ask-star"
                onClick={() => void star()}>
                <StarIcon className="h-3.5 w-3.5" filled /> {busy ? 'Starring…' : status.state === 'not-starred' && !failed ? `Star as @${status.login}` : 'Star on GitHub'}
              </button>
              <button type="button" className="btn btn-outline shrink-0 px-3 py-0.5 text-2xs" data-testid="star-ask-later" onClick={() => finish(false)}>Not now</button>
              <button type="button" className="shrink-0 px-1 text-2xs text-ink-faint underline-offset-2 hover:underline" data-testid="star-ask-never" onClick={() => finish(true)}>Don’t ask again</button>
            </div>
          )}
          {openError && <p className="mt-1.5 text-xs text-danger" role="alert">Couldn’t open GitHub. Visit {SUPPORT_REPOSITORY_URL} in your browser.</p>}
        </div>
        {thanked && (
          <button type="button" className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink" title="Close" aria-label="Close" onClick={onClose}>
            <CloseIcon className="h-3 w-3" />
          </button>
        )}
      </div>
    </section>
  );
}

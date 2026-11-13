import React, { useEffect, useState } from 'react';
import { SUPPORT_REPOSITORY_URL } from '@nekko-agent/shared';
import { CheckIcon, StarIcon } from '../icons.js';
import { refreshSupportStar, useSupportStar } from '../supportStar.js';
import { StarryNekko } from './StarryNekko.js';

/** One explicit support action shared by Good feedback and the top of Settings. */
export function GitHubStarSupport({ feedback = false }: { feedback?: boolean }) {
  const { status, busy, celebrating } = useSupportStar();
  const [openError, setOpenError] = useState(false);
  useEffect(() => {
    void refreshSupportStar();
    const refresh = () => { void refreshSupportStar(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  const starred = status?.state === 'starred';
  const open = async () => {
    setOpenError(false);
    try { await window.nekko.openPath(SUPPORT_REPOSITORY_URL); } catch { setOpenError(true); }
  };
  // In Settings it is a section like its neighbours, so its heading is the same level as theirs (#2624).
  const Heading = feedback ? 'h3' : 'h2';
  return (
    <section className={`min-w-0 ${feedback ? '' : 'settings-section'}`} data-testid="github-star-support">
      <div className="flex flex-wrap items-center gap-4">
        <span className={celebrating ? 'support-star-celebrate' : ''} data-testid="support-star-mascot">
          {starred ? <StarryNekko size={36} /> : <StarIcon className="h-6 w-6 text-ink-soft" />}
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <Heading className={`${feedback ? 'text-sm' : 'text-base'} font-semibold text-ink`}>{feedback ? 'Give us a GitHub star!' : 'Support by starring the project on GitHub'}</Heading>
          <p className="mt-(--q-tight) text-xs text-ink-faint" role="status">
            {busy ? 'Checking with GitHub…' : starred ? `Thank you, @${status.login}! Nekko is happy you’re here.`
              : status?.state === 'not-starred' ? `Star as @${status.login}. It helps more people find Nekko Agent.`
                : status?.reason ?? 'A little star helps more people find Nekko Agent.'}
          </p>
        </div>
        <button type="button" className={`btn ${starred ? 'btn-ghost' : 'btn-primary'} shrink-0 py-1 text-xs`} aria-pressed={starred} disabled={busy || starred || !status} data-testid="support-star-action"
          onClick={() => { if (status?.state === 'not-starred') void refreshSupportStar(true); else void open(); }}>
          {starred ? <><CheckIcon className="h-4 w-4" /> Starred</> : status?.state === 'not-starred' ? 'Give a star' : 'Open GitHub'}
        </button>
      </div>
      <div className="mt-(--q-inline) flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink-faint">
        <span>Starring is public on GitHub. We only add a star when you ask.</span>
        <button type="button" className="underline underline-offset-2" disabled={busy} onClick={() => void refreshSupportStar()}>Check status</button>
        {status?.state !== 'unavailable' && <button type="button" className="underline underline-offset-2" onClick={() => void open()}>View on GitHub</button>}
      </div>
      {openError && <p className="mt-(--q-inline) text-xs text-danger-text" role="alert">Couldn’t open GitHub. Visit {SUPPORT_REPOSITORY_URL} in your browser.</p>}
    </section>
  );
}

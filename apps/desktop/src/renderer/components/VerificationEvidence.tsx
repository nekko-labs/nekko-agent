import React from 'react';
import type { EvidencePair } from '../verificationEvidence.js';
import { localImagePath } from '../localImages.js';
import { LocalImageCard } from './LocalImageCard.js';
import { RemoteImageCard } from './RemoteImageCard.js';

/** Uses the originating Markdown session and existing image permission boundaries. */
export function VerificationEvidence({ pairs, basePath, panel = false }: { pairs: EvidencePair[]; basePath?: string; panel?: boolean }) {
  if (!pairs.length) return null;
  return <section aria-label={panel ? 'Verification screenshots' : 'Before and after screenshots'} data-verification-evidence={panel ? 'next-step' : 'inline'} className={panel ? 'my-3 rounded-xl border border-line bg-surface p-3' : 'my-3'}>
    {panel && <><h4 className="text-sm font-medium text-ink">Verify the visual changes</h4><p className="text-xs text-ink-soft">Compare the captured screenshots. Displaying evidence does not mean it has been inspected or approved.</p></>}
    {pairs.map(pair => <div key={pair.surface} className="min-w-0">
      <h5 className="text-xs font-medium text-ink">{pair.surface}</h5>
      <div className="grid min-w-0 gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))' }}>
        {(['before', 'after'] as const).map(side => <div key={side} className="min-w-0">
          <div className="text-xs font-medium text-ink-soft">{side === 'before' ? 'Before' : 'After'}</div>
          {localImagePath(pair[side].src, basePath)
            ? <LocalImageCard src={pair[side].src} title={pair[side].label} basePath={basePath} />
            : <RemoteImageCard url={pair[side].src} alt={pair[side].label} />}
        </div>)}
      </div>
    </div>)}
  </section>;
}

import React from 'react';

/** The wording shared with Hypergate's own catalog. */
export const NEKKO_LABS_TAG = 'Nekko Labs';
export const NEKKO_LABS_TITLE = 'Made by Nekko Labs';

/** A quiet word beside a connector's name that marks a Nekko Labs product (no fill, no border, tokens only). */
export function NekkoLabsTag() {
  return (
    <span className="shrink-0 text-2xs font-normal text-ink-faint" title={NEKKO_LABS_TITLE} data-nekko-labs-tag>
      {NEKKO_LABS_TAG}
    </span>
  );
}

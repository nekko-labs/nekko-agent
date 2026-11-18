import React from 'react';

/**
 * What a PR or issue tip shows: the state as glyph and word in the state's
 * hue with the repo and number beside it, then the title, then (when it
 * still matters) one faint line of detail.
 */
export function LinkTip({ glyph, tone, state, reference, title, meta }: { glyph: React.ReactNode; tone: string; state: string; reference: string; title?: string; meta?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-link-tip>
      <div className="flex min-w-0 items-center gap-1 text-2xs">
        <span style={{ color: tone }} className="inline-flex shrink-0">{glyph}</span>
        <span style={{ color: tone }} className="shrink-0 font-medium">{state}</span>
        <span className="min-w-0 truncate text-ink-faint">{reference}</span>
      </div>
      {title && <div className="line-clamp-3 text-xs font-medium leading-snug text-ink">{title}</div>}
      {meta && <div className="mt-1 flex flex-wrap items-center gap-x-2 text-2xs tabular-nums text-ink-faint">{meta}</div>}
    </div>
  );
}

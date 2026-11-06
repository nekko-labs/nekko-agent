import React, { useEffect, useState } from 'react';
import type { BackgroundState } from '@nekko-agent/shared';
import { NO_BACKGROUND, backgroundLine } from '@nekko-agent/shared';

/**
 * Automations running in the background on a local model, and whether they
 * are paused for you: read once, then followed live (`background:updated`).
 */
export function useBackgroundState(): BackgroundState {
  const [state, setState] = useState<BackgroundState>(NO_BACKGROUND);
  useEffect(() => {
    let live = true;
    window.nekko.backgroundState?.().then((s) => { if (live && s) setState(s); }).catch(() => {});
    const off = window.nekko.onBackgroundUpdated?.((s) => setState(s));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return state;
}

/**
 * "Background: 1 paused · you're using the computer": shown only while an
 * automation runs on a local model. `compact` is the resource chip's segment
 * ("BG paused"), with the whole line on hover.
 */
export function BackgroundChip({ state, compact = false }: { state: BackgroundState; compact?: boolean }) {
  const line = backgroundLine(state);
  if (!line) return null;
  const paused = state.paused > 0;
  const color = paused ? 'var(--warning)' : 'var(--success)';
  return (
    <span
      className={compact ? 'flex items-center gap-1' : 'flex min-w-0 items-center gap-2 rounded-full border border-line px-2 py-0.5 text-2xs text-ink-soft'}
      title={`${line}. ${paused ? 'It carries on from where it stopped once this computer is free.' : 'It pauses if you come back.'}`}
      data-background-chip={paused ? 'paused' : 'running'}
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      {compact ? (
        <>
          <span className="font-semibold text-ink-soft">BG</span>
          {paused ? 'paused' : 'running'}
        </>
      ) : (
        <span className="min-w-0 truncate">{line}</span>
      )}
    </span>
  );
}

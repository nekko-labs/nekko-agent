import { useEffect, useState } from 'react';
import { usePaneVisible } from '../../paneVisibility.js';
import { quietMinutes, watchQuietMinutes } from './toolProgress.js';

/** Informational, not an alert: silence is normal for many long-running tools. */
export function ToolProgressChip({ since }: { since: number }) {
  const visible = usePaneVisible();
  const [clock, setClock] = useState(() => ({ since, minutes: quietMinutes(since, Date.now()) }));
  useEffect(() => {
    if (!visible) return;
    setClock({ since, minutes: quietMinutes(since, Date.now()) });
    return watchQuietMinutes(since, (minutes) => setClock({ since, minutes }));
  }, [since, visible]);
  const minutes = clock.since === since ? clock.minutes : quietMinutes(since, Date.now());
  if (minutes < 1) return null;
  const explanation = `No progress reported for ${minutes} minute${minutes === 1 ? '' : 's'}. The tool is still running and may be working normally; this is not a hang diagnosis.`;
  return (
    <span
      className="shrink-0 rounded border border-line px-2 py-0.5 text-2xs font-normal tabular-nums text-ink-faint"
      aria-label={explanation}
      title={explanation}
    >
      no progress for {minutes} min
    </span>
  );
}

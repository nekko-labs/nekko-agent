import React, { useEffect, useState } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { MinusIcon, PlusIcon } from '../icons.js';
import { textScaleOf } from '../store.js';
import { stepTextScale } from '../textScale.js';

type Props = { settings: AppSettings; update: (patch: Partial<AppSettings>) => void };

/**
 * Settings > Accessibility's text size: step it up or down and watch the
 * preview, and only Apply changes the app. It saves the same `textScale` as
 * Settings > Style, so the two always agree. Leaving the page drops an
 * unapplied size.
 */
export function TextSizeSetting({ settings, update }: Props) {
  const applied = textScaleOf(settings.textScale);
  const [picked, setPicked] = useState<number | null>(null);
  // Also clears after Apply lands, or when Style or the palette changes the size.
  useEffect(() => setPicked(null), [applied]);
  const size = picked ?? applied;
  const step = (direction: 1 | -1) => setPicked(stepTextScale(size, direction));
  const stepButton = (direction: 1 | -1, label: string, icon: React.ReactNode) => (
    <button type="button" className="btn btn-outline p-1.5" aria-label={label} title={label} disabled={stepTextScale(size, direction) === size} onClick={() => step(direction)}>{icon}</button>
  );

  return <div className="mt-3">
    <div className="flex min-h-[40px] items-center justify-between gap-3">
      <div className="min-w-0"><span id="text-size-label" className="text-sm">Text size</span>
        <p className="text-2xs text-ink-faint">Scales all text and controls in the app, from 80% to 150%. Nothing changes until you press Apply.</p></div>
      <div className="flex shrink-0 items-center gap-2" role="group" aria-labelledby="text-size-label">
        {stepButton(-1, 'Decrease text size', <MinusIcon className="h-3.5 w-3.5" />)}
        <output className="w-12 text-center text-sm tabular-nums" aria-live="polite">{size}%</output>
        {stepButton(1, 'Increase text size', <PlusIcon className="h-3.5 w-3.5" />)}
      </div>
    </div>
    <div className="mt-2 overflow-hidden rounded-md border border-line p-3" role="group" aria-label="Text size preview" data-text-size-preview>
      {/* The root is already zoomed to the applied size, and zoom multiplies. */}
      <div style={{ zoom: size / applied }}>
        <p className="text-2xs text-ink-faint">Preview at {size}%</p>
        <p className="mt-1 font-semibold">Fix the failing test</p>
        <p className="text-sm">Nekko found the problem and is writing the fix now.</p>
        <p className="mt-1 text-xs text-ink-soft">Two files changed, a few seconds ago</p>
        <code className="mt-1 block text-xs">{'const nekko = () => "meow";'}</code>
      </div>
    </div>
    {size !== applied && <div className="mt-2 flex items-center justify-end gap-2">
      <button type="button" className="btn btn-outline py-1 text-xs" onClick={() => setPicked(null)}>Cancel</button>
      <button type="button" className="btn btn-primary py-1 text-xs" onClick={() => update({ textScale: size })}>Apply {size}%</button>
    </div>}
  </div>;
}

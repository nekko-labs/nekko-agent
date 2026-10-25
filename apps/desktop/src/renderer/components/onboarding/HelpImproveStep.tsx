import React, { useEffect, useState } from 'react';
import { TELEMETRY_PROMISES, telemetryChoice } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { Toggle } from '../primitives/Toggle.js';

/**
 * Asks once whether to send anonymous usage and crash reports. Off unless
 * switched on here; saved on Next, and skipping leaves it off.
 */
export function HelpImproveStep({
  commitRef,
}: {
  /** Set to the step's commit action; the wizard runs it on Next. */
  commitRef?: React.MutableRefObject<(() => Promise<void>) | null>;
} = {}) {
  const settings = useStore((s) => s.settings);
  const [on, setOn] = useState(settings?.telemetry?.enabled === true);

  useEffect(() => {
    if (!commitRef) return;
    commitRef.current = async () => {
      if (on === (settings?.telemetry?.enabled === true)) return;
      const next = await window.nekko.updateSettings({ telemetry: telemetryChoice(on) });
      useStore.setState({ settings: next });
    };
    return () => {
      commitRef.current = null;
    };
  }, [commitRef, on, settings?.telemetry?.enabled]);

  return (
    <div className="w-full">
      <h1 className="text-center text-2xl font-semibold tracking-tight">Help improve Nekko Agent?</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-[13px] text-ink-soft">
        Optional. Anonymous reports of which features get used and what breaks help us fix bugs and decide what to build.
      </p>
      <div className="mt-5 rounded-xl border p-4" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[14px] font-semibold">Send anonymous usage and crash reports</span>
          <Toggle label="Send anonymous usage and crash reports" value={on} onChange={setOn} />
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[12px] text-ink-soft">
          {TELEMETRY_PROMISES.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </div>
    </div>
  );
}

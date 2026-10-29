import { useEffect, useState } from 'react';
import { TELEMETRY_PROMISES, telemetryChoice, type AppSettings } from '@nekko-agent/shared';
import { Toggle } from './primitives/Toggle.js';

/** Settings > System: the opt-in usage and crash reports, with what they promise. */
export function UsageReportsSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const on = settings.telemetry?.enabled === true;
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    window.nekko.telemetryStatus().then((s) => setConfigured(s.configured), () => {});
  }, []);
  return (
    <section className="card mt-5 p-5" id="usage-reports">
      <div className="flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Help improve Nekko Agent</h2>
          <p className="text-[12px] text-ink-faint">Send anonymous usage and crash reports. Every send shows in Settings &gt; Connections.</p>
        </div>
        <Toggle label="Send anonymous usage and crash reports" value={on} onChange={(v) => update({ telemetry: telemetryChoice(v) })} />
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-ink-faint">
        {TELEMETRY_PROMISES.map((p) => <li key={p}>{p}</li>)}
      </ul>
      {on && !configured && <p className="mt-2 text-[11px] text-ink-faint" role="status">This build has nowhere to send reports yet, so nothing is sent.</p>}
    </section>
  );
}

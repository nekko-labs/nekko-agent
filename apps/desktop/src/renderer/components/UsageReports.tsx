import { useEffect, useState } from 'react';
import { TELEMETRY_PROMISES, telemetryChoice, type AppSettings } from '@nekko-agent/shared';
import { Toggle } from './primitives/Toggle.js';
import { SettingsSection } from './SettingsSection.js';

/** Settings > Help out the Nekko Team: the opt-in usage and crash reports, with what they promise. */
export function UsageReportsSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const on = settings.telemetry?.enabled === true;
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    window.nekko.telemetryStatus().then((s) => setConfigured(s.configured), () => {});
  }, []);
  return (
    <SettingsSection
      id="usage-reports"
      title="Help improve Nekko Agent"
      help={<>Send anonymous usage and crash reports. Every send shows in Settings &gt; Connections.</>}
      actions={<Toggle label="Send anonymous usage and crash reports" value={on} onChange={(v) => update({ telemetry: telemetryChoice(v) })} />}
    >
      <ul className="mt-(--q-inline) list-disc space-y-2 pl-5 text-xs text-ink-faint">
        {TELEMETRY_PROMISES.map((p) => <li key={p}>{p}</li>)}
      </ul>
      {on && !configured && <p className="mt-(--q-inline) text-xs text-ink-faint" role="status">This build has nowhere to send reports yet, so nothing is sent.</p>}
    </SettingsSection>
  );
}

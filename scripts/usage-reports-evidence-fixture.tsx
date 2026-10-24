import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppSettings } from '@nekko-agent/shared';
import { useStore } from '../apps/desktop/src/renderer/store';
import { HelpImproveStep } from '../apps/desktop/src/renderer/components/onboarding/HelpImproveStep';
import { UsageReportsSection } from '../apps/desktop/src/renderer/components/UsageReports';
import '../apps/desktop/src/renderer/styles.css';

// No backend: reports have nowhere to go, as in this build.
Object.assign(window, {
  nekko: new Proxy({}, { get: (_t, k: string) => (k === 'telemetryStatus' ? () => Promise.resolve({ enabled: true, configured: false, queued: 0 }) : k.startsWith('on') ? () => () => {} : () => Promise.resolve(null)) }),
});
try { localStorage.clear(); } catch {}
useStore.setState({ pushToast: () => {}, settings: {} } as any);

function Fixture() {
  const [settings, setSettings] = useState({ telemetry: { enabled: true, installId: 'x' } } as unknown as AppSettings);
  const update = (patch: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...patch }));
  return (
    <main className="bg-paper" style={{ minHeight: '100vh', padding: 24 }}>
      <div data-evidence="onboarding" className="card mx-auto p-6" style={{ maxWidth: 640 }}><HelpImproveStep /></div>
      <div data-evidence="settings" className="mx-auto" style={{ maxWidth: 760, marginTop: 24 }}>
        <UsageReportsSection settings={settings} update={update} />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

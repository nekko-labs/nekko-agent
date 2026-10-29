import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppSettings } from '@nekko-agent/shared';
import { useStore } from '../apps/desktop/src/renderer/store';
import { WorkTrackingStep } from '../apps/desktop/src/renderer/components/onboarding/WorkTrackingStep';
import { ProjectManagementSection, PullRequestsSection } from '../apps/desktop/src/renderer/views/SettingsView';
import '../apps/desktop/src/renderer/styles.css';

// No backend: every bridge call resolves empty.
Object.assign(window, {
  nekko: new Proxy({}, { get: (_t, k: string) => (k.startsWith('on') ? () => () => {} : () => Promise.resolve(null)) }),
});
try { localStorage.clear(); } catch {}
useStore.setState({ pushToast: () => {} } as any);

// Settings as an existing user sees them: issues on by default, one include answered, the rest unset.
function Fixture() {
  const [settings, setSettings] = useState({ projectManagement: { includePrompt: true } } as unknown as AppSettings);
  const update = (patch: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...patch }));
  return (
    <main className="bg-paper" style={{ minHeight: '100vh', padding: 24 }}>
      <div data-evidence="onboarding" className="card mx-auto p-6" style={{ maxWidth: 640 }}><WorkTrackingStep /></div>
      <div data-evidence="settings" className="mx-auto" style={{ maxWidth: 760, marginTop: 24 }}>
        <ProjectManagementSection settings={settings} update={update} />
        <PullRequestsSection settings={settings} update={update} />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

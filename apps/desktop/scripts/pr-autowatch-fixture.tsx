// Synthetic bridge only. No host, provider requests, credentials or external I/O.
// The host-armed "watch until merge-ready" chip and its Settings toggle.
// Run: NEKKO_FIXTURE=pr-autowatch-fixture.tsx NEKKO_SANDBOX=pr-autowatch-sandbox.cjs node chat-search-integration.cjs
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActiveWatchChips } from '../src/renderer/components/ActiveWatchChips';
import { PullRequestToggles } from '../src/renderer/components/WorkTrackingToggles';
import '../src/renderer/styles.css';

const now = Date.now();
const watches = [{ id: '3f1c2a9e-auto-fixture', kind: 'pr', url: 'https://github.com/nekko-labs/nekko-agent/pull/1700', status: 'active', deadlineAt: now + 3 * 3600_000, nextPollAt: now + 60_000, failures: 0, pending: false, auto: true }];
(window as any).nekko = new Proxy({ listAgentWatches: async () => watches }, {
  get(t: any, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return async () => null; },
});

function Settings() {
  const [value, setValue] = useState({});
  return <section className="card p-4" data-pr-settings>
    <h2 className="text-sm font-semibold">Pull requests</h2>
    <PullRequestToggles value={value} onChange={setValue} />
  </section>;
}

createRoot(document.getElementById('root')!).render(
  <div className="flex min-h-screen flex-col gap-6 bg-surface p-6 text-ink" style={{ width: 640 }}>
    <div className="rounded-lg border border-line" data-chip-host><ActiveWatchChips sessionId="fixture" /></div>
    <Settings />
  </div>,
);

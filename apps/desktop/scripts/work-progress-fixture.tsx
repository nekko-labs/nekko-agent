import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrActionCard } from '../src/renderer/components/PrCard';
import { VerificationChecklist } from '../src/renderer/components/WorkProgress';
const url = 'https://github.com/example/fixture/pull/42';
const opened: string[] = [];
(window as any).nekko = { openPath: async (value: string) => { opened.push(value); } };
(window as any).__opened = opened;
function Fixture() {
  const [updated, setUpdated] = useState(false);
  (window as any).__update = (value = true) => setUpdated(value);
  const now = Date.now();
  const steps: any[] = [
    { id: 'desktop', title: 'Inspect desktop verification states', status: 'active', updatedAt: now - (updated ? 180000 : 1000), verification: { status: updated ? 'passed' : 'active', device: 'Desktop · 900px', detail: updated ? 'Synthetic example of an agent-reported inspection result.' : 'Checking the active verification state.', evidenceUrl: 'https://example.test/evidence/desktop' } },
    { id: 'narrow', title: 'Inspect narrow layout and evidence destinations', status: 'pending', updatedAt: now - (updated ? 180000 : 1000), verification: { status: updated ? 'blocked' : 'pending', device: 'Narrow · 390px', detail: updated ? 'External device inspection unavailable. Renderer capture is not visual inspection.' : 'Waiting for desktop verification.' } },
  ];
  const info: any = { url, owner: 'example', repo: 'fixture', number: 42, title: 'Show explicit verification and pull request progress', state: 'open', checks: updated ? 'failing' : 'pending', isDraft: false, checkedAt: now - (updated ? 180000 : 1000), checkProgress: { total: 3, completed: updated ? 2 : 1, pending: updated ? 0 : 2, failing: updated ? 1 : 0, unknown: 0, items: [{ name: 'Renderer integration', state: updated ? 'completed' : 'pending', link: 'https://example.test/check/renderer' }, { name: 'Unit tests', state: 'completed', link: null }, { name: 'Device checks', state: updated ? 'failing' : 'pending', link: null }] }, reviewThreads: { total: 4, resolved: updated ? 3 : 1, unresolved: updated ? 1 : 3 } };
  return <main><h1>Work progress</h1><p className="caption">Isolated synthetic verification scene</p><section data-scene="verification"><VerificationChecklist steps={steps} /></section><section data-scene="pr"><PrActionCard url={url} info={info} sessionId="fixture" onDismiss={() => {}} /></section></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

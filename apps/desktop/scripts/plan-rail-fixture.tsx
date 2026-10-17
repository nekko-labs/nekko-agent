// Synthetic "This prompt" panel for isolated before/after screenshots.
// No real data: one parent chat with a published plan and two sub-agents.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { PlanRail } from '../src/renderer/components/PlanRail';
import '../src/renderer/styles.css';

const listeners = new Set<(e: any) => void>();
(window as any).nekko = {
  onAgentEvent: (cb: (e: any) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
  listSessionSummaries: async () => useStore.getState().sessions,
};

const parent = {
  id: 'parent', title: 'Synthetic parent', createdAt: 1, updatedAt: 1, messages: [],
  agentPlan: [
    { id: 'a', title: 'Inspect the panel component', status: 'done', note: 'PlanRail.tsx' },
    { id: 'b', title: 'Reorder the sections', status: 'active' },
    { id: 'c', title: 'Run focused tests in parallel', status: 'active' },
    { id: 'd', title: 'Publish evidence and land the change', status: 'pending' },
    { id: 'e', title: 'Animate the working icon', status: 'skipped', note: 'Static status needs no motion.' },
  ],
} as any;
const child = (id: string, title: string, lastReplyText?: string) => ({ id, title, parentSessionId: 'parent', createdAt: 2, updatedAt: 2, lastReplyText } as any);

useStore.setState({
  sessions: [child('child1', 'Inspect layout'), child('child2', 'Verify styles', 'Done.')],
  settings: { providers: [], guardrails: [], workspaces: [] } as any,
} as any);

function Fixture() {
  return (
    <div data-plan-rail-fixture style={{ width: '100%', height: 560, background: 'var(--win, var(--surface))' }}>
      <PlanRail sessionId="parent" session={new URLSearchParams(location.search).has('paused') ? { ...parent, messages: [{ role: 'assistant', content: 'Stopped part-way.', interrupted: true }] } : parent} streaming={!new URLSearchParams(location.search).has('paused')} onChangePlan={() => {}} />
    </div>
  );
}

Object.assign(window, { integration: { emit: (e: any) => listeners.forEach((l) => l(e)) } });
createRoot(document.getElementById('root')!).render(<Fixture />);

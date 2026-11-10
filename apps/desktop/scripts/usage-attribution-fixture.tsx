// The Budget monitor with usage attribution (#2494). Synthetic usage only; no
// host or network. `?before` gives the same days without attribution, as an
// older engine reports them.
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { UsageSummary } from '@nekko-agent/shared';
import { useStore } from '../src/renderer/store';
import { MonitorsDock } from '../src/renderer/components/MonitorsDock';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import '../src/renderer/styles.css';

window.addEventListener('error', (e) => console.error('STACK ' + (e.error?.stack ?? e.message).slice(0, 600)));
const before = location.search.includes('before');
const slice = (input: number, cacheRead: number, cacheWrite: number, output: number, cost: number) => ({ input, cacheRead, cacheWrite, output, cost, listCost: cost });
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const day = (date: string, k: number) => ({
  date, input: 4_100_000 * k, output: 180_000 * k, cost: 3.1 * k, bySessionCost: { a: 2.2 * k, b: 0.9 * k }, localTokens: 0,
  avoidedCosts: { local: 0, subscription: 0, unpricedTokens: 0, benchmarkTokens: 0 }, modelIds: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  ...(before ? {} : { attribution: {
    user: slice(310_000 * k, 2_400_000 * k, 160_000 * k, 90_000 * k, 1.4 * k),
    background: slice(120_000 * k, 980_000 * k, 130_000 * k, 90_000 * k, 1.7 * k),
    parent: slice(250_000 * k, 2_100_000 * k, 150_000 * k, 100_000 * k, 1.8 * k),
    subagent: slice(180_000 * k, 1_280_000 * k, 140_000 * k, 80_000 * k, 1.3 * k),
  } }),
});
const usage = {
  totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, byProvider: {}, bySession: {}, bySessionCost: {},
  daily: [day(yesterday, 1), day(today, 0.5)],
} as unknown as UsageSummary;
(window as any).nekko = new Proxy({}, { get(_t, k: string) { if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(/^(list|get.*s$)/.test(k) ? [] : null); } });
useStore.setState({ sessions: [], settingsLoaded: true, settings: { providers: [], guardrails: [], monitors: {} } as any } as any);

function Fixture() {
  const [wall, setWall] = React.useState({ ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, show: true, simpleShow: true, side: 'right' as const, monitors: { ...Object.fromEntries(Object.keys(DEFAULT_WALL_STATE.dock.monitors).map((k) => [k, false])), budget: true } as any, monitorOrder: ['budget'] as any, minimized: {} } });
  return <div className="bg-paper" style={{ display: 'flex', justifyContent: 'center', padding: 16, minHeight: '100vh' }}>
    <div data-shot="budget" style={{ display: 'flex', width: 340, height: 1000 }}>
      <MonitorsDock state={wall as any} setState={setWall as any} tasks={[]} running={new Set()} now={Date.now()} sessions={[{ id: 'a', title: 'Ship the subagent picker' } as any]} providers={[]} usage={usage} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] } as any}
        onOpenChat={() => {}} onOpenModels={() => {}} />
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

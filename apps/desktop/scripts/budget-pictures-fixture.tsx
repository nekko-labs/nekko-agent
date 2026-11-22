// Synthetic only: the Monitors dock with the Budget panel, two paid cloud pictures today (#2973).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MonitorsDock } from '../src/renderer/components/MonitorsDock';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import '../src/renderer/styles.css';
const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
// Today's $0.42 includes two paid pictures ($0.071); older hosts' days carry no picture fields.
const usage: any = { totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, byProvider: {}, bySession: {}, bySessionCost: {},
  avoidedCosts: { local: 1.23, subscription: 4.56, benchmarkTokens: 0, unpricedTokens: 0 },
  daily: [{ date: today, input: 12000, output: 3400, cost: 0.42, bySessionCost: { kites: 0.42 }, localTokens: 0, modelIds: [],
    avoidedCosts: { local: 1.23, subscription: 4.56, benchmarkTokens: 0, unpricedTokens: 0 }, pictures: 2, pictureCost: 0.071 }] };
const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, show: true, simpleShow: true, monitors: { automations: false, utilization: false, budget: true, hardware: false, localModels: false } } };
(window as any).nekko = new Proxy({}, { get: (_t, k: string) => (k.startsWith('on') ? () => () => {} : async () => null) });
(window as any).budgetFixture = true;
createRoot(document.getElementById('root')!).render(<div style={{ width: '100vw', height: '100vh', overflow: 'auto' }}>
  <MonitorsDock state={state as any} setState={() => {}} tasks={[]} running={new Set()} now={now} sessions={[{ id: 'kites', title: 'Kites for the landing page' } as any]} providers={[]} usage={usage} onOpenChat={() => {}} onOpenModels={() => {}} />
</div>);

// Synthetic usage only. No host bridge, billing account or saved chats.
import { createRoot } from 'react-dom/client';
import type { SessionSummary, UsageSummary } from '@nekko-agent/shared';
import { MonitorsDock } from '../src/renderer/components/MonitorsDock';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import '../src/renderer/styles.css';

const now = Date.parse('2026-11-27T12:00:00Z');
const usage: UsageSummary = {
  totalInput: 1_200_000, totalOutput: 10_000, totalCost: 0.42,
  byModel: {}, byProvider: {}, bySession: {}, bySessionCost: { kites: 0.42, seeds: 0.12 },
  daily: [
    { date: '2026-11-27', input: 1_200_000, output: 10_000, cost: 0.42, bySessionCost: { kites: 0.42, seeds: 0.12 }, localTokens: 940_000,
      avoidedCosts: { local: 1.23, subscription: 4.56, benchmarkTokens: 940_000, unpricedTokens: 0 } },
    { date: '2026-11-26', input: 100, output: 50, cost: 0, bySessionCost: { seeds: 0 }, localTokens: 0,
      avoidedCosts: { local: 0, subscription: 0.2, benchmarkTokens: 0, unpricedTokens: 0 } },
  ],
};
const dock = { ...DEFAULT_WALL_STATE.dock, show: true, simpleShow: true, monitors: { automations: false, utilization: false, budget: true, hardware: false, localModels: false } };
const sessions = [{ id: 'seeds', title: 'Sort the seeds' }, { id: 'kites', title: 'Sketch the kites' }] as SessionSummary[];
Object.assign(window, { nekko: new Proxy({}, { get: (_t, k: string) => k.startsWith('on') ? () => () => {} : async () => null }) });
createRoot(document.getElementById('root')!).render(<main style={{ width: '100vw', height: '100vh', overflow: 'auto' }}>
  <MonitorsDock state={{ ...DEFAULT_WALL_STATE, dock }} setState={() => {}} tasks={[]} running={new Set()} now={now} sessions={sessions} providers={[]} usage={usage}
    onOpenChat={(id) => { document.body.dataset.openedChat = id; }} onOpenModels={() => {}} />
</main>);

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_RUNNER_SETTINGS } from '@nekko-agent/shared';
import { useStore } from '../apps/desktop/src/renderer/store';
import { DEFAULT_WALL_STATE, sanitizeMonitorsDock } from '../apps/desktop/src/renderer/commandWall';
import { MonitorsDock } from '../apps/desktop/src/renderer/components/MonitorsDock';
import '../apps/desktop/src/renderer/styles.css';

// Synthetic only: no host, daemon, network or user data.
const now = Math.floor(Date.now() / 1000);
const job = (jobId: number) => ({ repo: 'nekko-labs/nekko-agent', runId: jobId, jobId, workflow: 'Native iOS', job: 'protocol-and-build', steps: { done: 18, total: 24, current: 'Simulator tests and lint' } });
const recent = [0, 1, 2, 3, 4].map((i) => ({ ts: now - 600 * (i + 1), runnerId: 'r1', repo: 'nekko-labs/nekko-agent', workflow: 'ci', job: `job ${i}`, result: 'finished', seconds: 300, reason: [] }));
const runner = {
  config: { id: 'r1', scope: { kind: 'org', org: 'nekko-labs' }, label: 'nekko-cloud-mac', settings: { ...DEFAULT_RUNNER_SETTINGS, enabled: true, macosSlots: 2 } },
  state: 'running', reasons: [], available: 2, limit: null, awake: true, error: null, queue: [],
  slots: [{ state: 'running', vm: 'vm-1', job: job(1), since: now - 3000, drainEndsAt: null }, { state: 'running', vm: 'vm-2', job: job(2), since: now - 2940, drainEndsAt: null }],
  today: { jobs: 7, seconds: 7800 }, repos: [], forkApprovalOpen: false, suggestedSize: null,
  host: { ramMb: 32768, cores: 10, recommendedMemoryMb: 16384, runnerMemoryMb: 16384, cpusPerVm: 4, onBattery: false, batteryPct: 100, networkId: 'home', networkTrusted: true },
  recent,
};
const bridge: any = { listRunners: async () => [runner], imageStatus: async () => null };
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
useStore.setState({ settings: { theme: 'dark' }, toasts: [] } as any);
const tasks: any[] = [{ id: 't1', title: 'Morning brief', kind: 'recurring', status: 'active', createdAt: 1, runCount: 4, lastRunAt: Date.now() - 3600_000, nextRunAt: Date.now() + 5 * 3600_000 }];
function Fixture() {
  const [state, setState] = useState<any>({ ...DEFAULT_WALL_STATE, dock: sanitizeMonitorsDock({ side: 'right', show: true, monitorOrder: ['automations', 'utilization', 'budget', 'hardware'], panels: { automations: true, utilization: true, budget: true, hardware: true }, minimized: {} }) });
  return <main className="bg-paper" style={{ height: '100vh', display: 'flex', justifyContent: 'flex-end' }}>
    <MonitorsDock state={state} setState={setState} tasks={tasks} running={new Set()} now={Date.now()} sessions={[]} providers={[]} usage={null} onOpenChat={() => {}} onOpenModels={() => {}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

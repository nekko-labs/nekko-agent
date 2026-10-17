// Synthetic evidence fixture for three surfaces: the Agent Monitor's Project
// group, the Hardware monitor's temperatures, and the Dynamic toolbar's
// Screens dropdown. No host, no network; every reading is made up here.
import './monitors-trio-chrome';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { PlanRail } from '../src/renderer/components/PlanRail';
import { MonitorsDock } from '../src/renderer/components/MonitorsDock';
import { WallToolbar } from '../src/renderer/views/CommandCenterView';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import '../src/renderer/styles.css';

const params = new URLSearchParams(location.search);
// `repo`: no PM connector, the chat's repo has a TASKS.md. `linear`: Linear is connected.
const source = params.get('source') ?? 'repo';
const tasksMd = '# Now\n- [ ] Ship the multi-monitor toggle\n- [ ] Add temperature rows\n- [x] Project group\n## Later\n- [ ] Per-screen Settings page\n';
const bridge: any = {
  listDir: async () => [{ name: 'README.md', path: 'C:/fixture/repo/README.md', dir: false }, { name: 'TASKS.md', path: 'C:/fixture/repo/TASKS.md', dir: false }],
  readFile: async () => ({ content: tasksMd, truncated: false, binary: false }),
  fetchConnector: async () => [
    { id: 'ENG-412', title: 'ENG-412 Multi-monitor support in Dynamic mode', subtitle: 'Linear · In Progress', url: 'https://linear.app/x/ENG-412' },
    { id: 'ENG-409', title: 'ENG-409 Temperature sensors in the Hardware monitor', subtitle: 'Linear · Todo' },
    { id: 'ENG-401', title: 'ENG-401 Project group in the Agent Monitor', subtitle: 'Linear · Todo' },
  ],
  getSystemStats: async () => ({ cpuPct: 31, cpuCores: 32, memUsedMB: 35182, memTotalMB: 49152, temps: { cpuC: 64, memoryC: 47 } }),
  getGpuStats: async () => ({ source: 'nvidia-smi', totalMB: 32607, usedMB: 10766, freeMB: 21841, devices: [{ name: 'Fixture RTX 5090', memoryTotalMB: 32607, memoryUsedMB: 10766, memoryFreeMB: 21841, utilizationPct: 62, temperatureC: 83 }] }),
  updateSettings: async (p: any) => ({ ...useStore.getState().settings, ...p }),
  listSessionSummaries: async () => useStore.getState().sessions,
};
(window as any).nekko = new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } });

const parent = { id: 'parent', title: 'Fixture chat', createdAt: 1, updatedAt: 1, workspaceId: 'ws', messages: [],
  agentPlan: [{ id: 'a', title: 'Read the monitor panel', status: 'done' }, { id: 'b', title: 'Add the Project group', status: 'active' }] } as any;
useStore.setState({
  sessions: [], settingsLoaded: true,
  settings: { providers: [], guardrails: [], workspaces: [{ id: 'ws', name: 'nekko-agent', path: 'C:/fixture/repo' }], monitors: { cpu: true, memory: true, gpu: true, vram: true },
    connectors: source === 'linear' ? [{ kind: 'linear', connected: true }] : [] } as any,
} as any);

function Fixture() {
  const [wall, setWall] = React.useState({ ...DEFAULT_WALL_STATE, layout: { ...DEFAULT_WALL_STATE.layout, mode: 'grid' as const }, dock: { ...DEFAULT_WALL_STATE.dock, show: true, side: 'right' as const, monitors: { ...DEFAULT_WALL_STATE.dock.monitors, hardware: true }, monitorOrder: ['hardware'] as any, minimized: {} } });
  return <div className="bg-paper" style={{ display: 'grid', gridTemplateColumns: '300px 420px', gridTemplateRows: 'auto 1fr', gap: 16, padding: 16, width: 1400, minHeight: 860 }}>
    <div data-shot="toolbar" className="titlebar" style={{ gridColumn: '1 / span 2', width: 1360, paddingTop: 12, paddingBottom: 300, display: 'flex' }}>
      {/* The title bar's toolbar slot the controls portal into on desktop. */}
      <div id="command-titlebar-slot" style={{ flex: 1, display: 'flex', margin: 0 }} />
      <WallToolbar wall={wall} setWall={setWall as any} onAutoArrange={() => {}} addOpen={false} setAddOpen={() => {}} onAdd={() => {}} />
    </div>
    <div data-shot="monitor" style={{ height: 520, background: 'var(--win, var(--surface))' }}>
      <PlanRail sessionId="parent" session={parent} streaming={false} />
    </div>
    <div data-shot="hardware" style={{ display: 'flex' }}>
      <MonitorsDock state={wall as any} setState={setWall as any} tasks={[]} running={new Set()} now={Date.now()} sessions={[]} providers={[]} usage={null}
        vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] } as any} onOpenChat={() => {}} onOpenModels={() => {}} />
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

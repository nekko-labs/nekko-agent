// Synthetic evidence fixture for the simulator surfaces (#2814): the monitor
// chip, the Hardware monitor's Simulators group, the chat's Simulator panel
// in its Agent Monitor and the status line above the composer. No host, no
// network: the devices are made up here, and the screen is whatever the
// sandbox hands in as `window.__simulatorShot` (a real simctl screenshot).
import './monitors-trio-chrome';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { PlanRail } from '../src/renderer/components/PlanRail';
import { MonitorsDock } from '../src/renderer/components/MonitorsDock';
import { ResourceHud } from '../src/renderer/components/ResourceMonitor';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
// SIMULATOR-STATUS-IMPORT
import { SimulatorStatus } from '../src/renderer/components/Simulators';
import '../src/renderer/styles.css';

const now = Date.now();
const devices = [
  { id: 'A205885C-E689-4FCE-93EE-E39B21CC52F8', kind: 'ios', name: 'Nekko-1314-iPad', model: 'iPad Pro 13-inch (M5)', os: 'iOS 26.5', cpuPct: 95.1, upSecs: 10 * 3600, processes: 274, canOpen: true, lastUse: { sessionId: 'chat-a', at: now - 2 * 60_000, title: 'iPad PanesTests' } },
  { id: '937C0078-69EC-4BEF-8C34-710DA0A4F98F', kind: 'ios', name: 'Nekko-1882-phone-setup-owned', model: 'iPhone 17 Pro', os: 'iOS 26.5', cpuPct: 0.4, upSecs: 9 * 86_400, processes: 304, canOpen: true },
  { id: 'agent2649_api36', kind: 'android', name: 'agent2649 api36', os: 'Android', cpuPct: 6.2, upSecs: 25 * 3600, processes: 2, canOpen: false, serial: 'emulator-5594', lastUse: { sessionId: 'chat-b', at: now - 3 * 3600_000, title: null } },
];
const state = { devices, sampledAt: now, autoShutdownMinutes: null };
const bridge: any = {
  getSystemStats: async () => ({ cpuPct: 98, cpuCores: 10, memUsedMB: 30182, memTotalMB: 32768 }),
  getGpuStats: async () => null,
  listDir: async () => [],
  listRunners: async () => [],
  readFile: async () => ({ content: '', truncated: false, binary: false }),
  simulatorsState: async () => state,
  simulatorsScreenshot: async () => {
    const data = (window as any).__simulatorShot;
    if (!data) throw new Error('not yet');
    return { mime: 'image/jpeg', data, at: Date.now() };
  },
  updateSettings: async (p: any) => ({ ...useStore.getState().settings, ...p }),
  listSessionSummaries: async () => useStore.getState().sessions,
};
(window as any).nekko = new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } });

const chat = { id: 'chat-a', title: 'iPad PanesTests', createdAt: 1, updatedAt: 1, workspaceId: 'ws', messages: [] } as any;
useStore.setState({
  sessions: [], settingsLoaded: true,
  settings: { providers: [], guardrails: [], workspaces: [{ id: 'ws', name: 'nekko-agent', path: '/fixture/repo' }], monitors: { cpu: true, memory: true, gpu: false, vram: false }, connectors: [], simulatorAutoShutdownMinutes: 15 } as any,
} as any);

function Fixture() {
  const [wall, setWall] = React.useState({ ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, show: true, side: 'right' as const, simpleShow: true, monitors: { ...DEFAULT_WALL_STATE.dock.monitors, hardware: true }, monitorOrder: ['hardware'] as any, minimized: {} } });
  return <div className="bg-paper" style={{ display: 'grid', gridTemplateColumns: '280px 300px 480px', gap: 24, padding: 20, width: 1180, minHeight: 900, alignItems: 'start' }}>
    <div data-shot="monitor" style={{ height: 820, background: 'var(--win, var(--surface))' }}>
      <PlanRail sessionId="chat-a" session={chat} />
    </div>
    <div data-shot="hardware" style={{ display: 'flex' }}>
      <MonitorsDock state={wall as any} setState={setWall as any} tasks={[]} running={new Set()} now={now} sessions={[]} providers={[]} usage={null} onOpenChat={() => {}} onOpenModels={() => {}} />
    </div>
    <div style={{ display: 'grid', gap: 24 }}>
      <div data-shot="composer" style={{ padding: 12, background: 'var(--paper)' }}>
        <div className="composer" style={{ borderRadius: 16, border: '1px solid var(--line)', background: 'var(--surface)' }}>
          <SimulatorStatus sessionId="chat-a" onOpen={() => {}} />
          <div style={{ padding: '12px 16px', color: 'var(--ink-faint)', fontSize: 14 }}>Ask the agent…</div>
        </div>
      </div>
      <div data-shot="chip" style={{ position: 'relative', height: 420, transform: 'translateZ(0)' }}>
        <ResourceHud />
      </div>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

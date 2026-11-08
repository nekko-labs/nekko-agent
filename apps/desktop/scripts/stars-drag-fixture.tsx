// Isolated renderer fixture. Synthetic settings, no host or provider access.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { ModelPicker } from '../src/renderer/components/agent-console/ModelPicker';
import { MonitorsDock } from '../src/renderer/components/MonitorsDock';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import '../src/renderer/styles.css';
const providers: any[] = [{ id: 'fixture', kind: 'openai', label: 'Fixture provider', enabled: true }];
const models: any[] = [{ id: 'star', name: 'Starred model', providerId: 'fixture' }, { id: 'regular', name: 'Regular model', providerId: 'fixture' }];
const bridge: any = {
  listModels: async () => models,
  getSettings: async () => useStore.getState().settings,
  updateSettings: async (patch: any) => { useStore.setState({ settings: { ...useStore.getState().settings, ...patch } as any }); return useStore.getState().settings; },
};
(window as any).nekko = new Proxy(bridge, { get(t, k: string) { return t[k] ?? (k.startsWith('on') ? () => () => {} : () => Promise.resolve(null)); } });
useStore.setState({ settingsLoaded: true, sessions: [], settings: { providers, favoriteModels: ['fixture::star'], workspaces: [], connectors: [], guardrails: [] } as any });
function Fixture() {
  const [wall, setWall] = React.useState({ ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, show: true, side: 'right' as const, monitors: { automations: true, budget: true, utilization: false, hardware: false, localModels: false }, minimized: {} } });
  return <main style={{ display: 'flex', gap: 40, padding: 32, height: '100vh', background: 'var(--paper)' }}>
    <div style={{ width: 380, height: 580 }}><ModelPicker expanded open providers={providers} models={models} providerId="fixture" modelId="regular" onOpenChange={() => {}} onProvider={() => {}} onModel={(_p, m) => { (window as any).picked = m; }} /></div>
    <MonitorsDock state={wall as any} setState={setWall as any} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={null} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] } as any} onOpenChat={() => {}} onOpenModels={() => {}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

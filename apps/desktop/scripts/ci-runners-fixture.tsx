import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { WorkflowsView } from '../src/renderer/views/WorkflowsView';
import { DEFAULT_RUNNER_SETTINGS, type AuditLine, type HostView, type RunnerView } from '@nekko-agent/shared';
import '../src/renderer/styles.css';

// Synthetic RunnerViews only. This fixture never connects to a host, daemon or GitHub.
const NOW = Math.floor(Date.now() / 1000);
const GB = 1024;
const host: HostView = {
  ramMb: 36 * GB, cores: 12, recommendedMemoryMb: 20 * GB, runnerMemoryMb: 20 * GB, cpusPerVm: 4,
  onBattery: false, batteryPct: 100, networkId: 'gw:a4:83:e7:1c:22:9f', networkTrusted: true,
};
const unsampled: HostView = { ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0, onBattery: null, batteryPct: null, networkId: null, networkTrusted: false };
const audit = (ago: number, job: string, result: AuditLine['result'], seconds: number, reason: string[] = []): AuditLine => ({
  ts: NOW - ago, runnerId: 'r1', repo: 'nekko-labs/nekko-agent', workflow: 'ios-native', job, result, seconds, reason,
});
const view = (over: Partial<RunnerView> = {}, settings: Partial<RunnerView['config']['settings']> = {}): RunnerView => ({
  config: {
    id: 'r1', scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' }, label: 'nekko-mac',
    settings: { ...DEFAULT_RUNNER_SETTINGS, enabled: true, macosSlots: 2, trustedNetworks: ['gw:a4:83:e7:1c:22:9f'], ...settings },
  },
  state: 'ready', slots: [], reasons: [], available: 2, limit: null, awake: false, error: null,
  today: { jobs: 0, seconds: 0 }, host, recent: [], ...over,
});

const scenes: Record<string, () => Promise<RunnerView[]>> = {
  'first-visit': async () => [],
  running: async () => [view({
    state: 'running', awake: true, reasons: ['userActive'],
    slots: [{ state: 'running', job: { repo: 'nekko-labs/nekko-agent', runId: 904, jobId: 9041, workflow: 'ios-native', job: 'PR #904' }, since: NOW - 11 * 60, drainEndsAt: null }],
    today: { jobs: 14, seconds: 2 * 3600 + 38 * 60 },
    recent: [audit(25 * 60, 'PR #903', 'finished', 14 * 60), audit(70 * 60, 'main', 'finished', 17 * 60), audit(3 * 3600, 'PR #899', 'lost', 6 * 60, ['slept'])],
  }, { priority: 'balanced' })],
  waiting: async () => [view({
    state: 'waiting', reasons: ['onBattery', 'network', 'userActive'], available: 1, limit: 'memory',
    host: { ...host, onBattery: true, batteryPct: 62, networkId: 'gw:10:0c:6e:5b:01:aa', networkTrusted: false },
    today: { jobs: 3, seconds: 41 * 60 },
  })],
  error: async () => [view({ state: 'error', error: 'No VM image yet.', today: { jobs: 0, seconds: 0 } }, { macosSlots: 1 })],
  'off-no-vm-support': async () => [view({ state: 'off', error: 'VM support unavailable: the nekko-vm helper is not installed.', host: unsampled, reasons: ['off'] }, { enabled: false, macosSlots: 1 })],
  'settings-no-vm-support': async () => [view({ state: 'off', error: 'VM support unavailable: the nekko-vm helper is not installed.', host: unsampled, reasons: ['off'] }, { enabled: false, macosSlots: 1 })],
  unavailable: async () => { throw new Error('unknown channel runner:list'); },
  'connect-step-3': async () => [],
  settings: async () => [view({ limit: 'memory', available: 1 })],
  'settings-bottom': async () => [view({ limit: 'memory', available: 1 })],
  'settings-unsampled': async () => [view({ host: unsampled, state: 'waiting', reasons: ['hostStateUnknown'] })],
};

let scene = 'first-visit';
const settings = { providers: [], workspaceFolders: [], workspaces: [], monitors: {}, theme: 'dark', experimental: {}, agent: {}, ui: {}, connectors: [] };
const bridge: any = {
  listRunners: () => scenes[scene](),
  listWorkflows: async () => ({ workflows: [], runs: [] }),
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'darwin' }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const show = (next: string) => {
    localStorage.clear();
    scene = next;
    useStore.setState({ view: 'workflows', providers: [], models: [], sessions: [], terminals: [], workspaces: [], settings, settingsLoaded: true, installedSkillDefs: [] } as any);
    setEpoch((e) => e + 1);
  };
  Object.assign(window, { integration: { show } });
  return <div style={{ height: '100vh', overflow: 'auto' }} className="bg-paper" key={epoch} data-scene={scene}><WorkflowsView /></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

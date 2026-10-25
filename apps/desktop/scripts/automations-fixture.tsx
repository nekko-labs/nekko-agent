import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { WorkflowsView } from '../src/renderer/views/WorkflowsView';
import * as Settings from '../src/renderer/views/SettingsView';
import { WorkflowEditor } from '../src/renderer/components/WorkflowEditor';
import { AutomationsPane } from '../src/renderer/components/AutomationsPane';
import { ScheduleTaskModal } from '../src/renderer/components/ScheduleTaskModal';
import { ResourceHud } from '../src/renderer/components/ResourceMonitor';
import { MonitorsDock } from '../src/renderer/components/MonitorsDock';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { LiveTurn } from '../src/renderer/components/agent-console/LiveTurn';
import { applyEvent, getLiveRun } from '../src/renderer/liveRuns';
import { describeLiveActivity, shortLiveStatus } from '@nekko-agent/shared';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host, daemon or engine.
const NOW = Date.now();
const MIN = 60_000;
const providers = [
  { id: 'nekko-engine', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:11500/v1', enabled: true, label: 'Nekko Agent engine', auth: 'none' },
  { id: 'cloud', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', enabled: true, label: 'Anthropic' },
];
const step = (id: string, run: string) => ({ id, name: id, kind: 'prompt', run });
const local = {
  id: 'wf-local', name: 'Nightly dependency check', category: 'Maintenance', enabled: true, createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000,
  providerId: 'nekko-engine', modelId: 'qwen3-8b', localModelOnly: true, toolAccess: 'read',
  triggers: [{ id: 's', kind: 'schedule', cron: '0 2 * * *' }], steps: [step('check', 'List outdated dependencies and summarize the risk.')],
  lastRunAt: NOW - 26 * 3_600_000, lastStatus: 'success', runCount: 4, waitingSince: NOW - 12 * MIN,
};
const review = {
  id: 'wf-review', name: 'Review every PR I open', category: 'Code review', enabled: true, createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000,
  providerId: 'nekko-engine', modelId: 'qwen3-8b', triggers: [{ id: 'c', kind: 'connector', connector: 'github', event: 'pr_opened' }],
  steps: [step('review', 'Review the pull request.')], lastRunAt: NOW - 40 * MIN, lastStatus: 'success', runCount: 2,
};
const run = (id: string, wf: string, started: number, extra: object = {}) => ({
  id, workflowId: wf, status: 'success', triggerKind: 'schedule', triggerLabel: 'cron 0 2 * * *', startedAt: started, endedAt: started + 95_000,
  steps: [{ stepId: 'check', status: 'success', attempt: 1, startedAt: started, endedAt: started + 95_000 }], ...extra,
});
const runs = [
  run('r3', 'wf-local', NOW - 26 * 3_600_000, { lowPriority: true, waitedMs: 7_200_000 }),
  run('r2', 'wf-local', NOW - 50 * 3_600_000),
  run('r1', 'wf-review', NOW - 40 * MIN, { triggerKind: 'connector', triggerLabel: 'GitHub · o/r · pr_opened', lowPriority: true, steps: [{ stepId: 'review', status: 'success', attempt: 1, startedAt: NOW - 40 * MIN, endedAt: NOW - 38 * MIN }] }),
];
const tasks = [
  { id: 't1', title: 'Summarize yesterday’s commits', kind: 'recurring', prompt: 'p', intervalMs: 86_400_000, providerId: 'nekko-engine', status: 'active', createdAt: NOW - 5 * 86_400_000, runCount: 4, lastRunAt: NOW - 86_400_000, lastResult: 'Three merges, no regressions.', nextRunAt: NOW - 8 * MIN, waitingSince: NOW - 8 * MIN },
  { id: 't2', title: 'Tidy the downloads folder', kind: 'recurring', prompt: 'p', intervalMs: 3_600_000, providerId: 'nekko-engine', status: 'active', createdAt: NOW - 86_400_000, runCount: 9, lastRunAt: NOW - 20 * MIN, lastRunLowPriority: true, lastRunWaitedMs: 7_200_000, lastResult: 'Moved 14 files.', nextRunAt: NOW + 40 * MIN },
  { id: 't3', title: 'Check the release notes draft', kind: 'scheduled', prompt: 'p', runAt: NOW + 3 * 3_600_000, providerId: 'cloud', status: 'active', createdAt: NOW - 3_600_000, runCount: 0, nextRunAt: NOW + 3 * 3_600_000 },
];
const settings = { providers, defaultProviderId: 'nekko-engine', defaultModelId: 'qwen3-8b', workspaceFolders: [], workspaces: [], monitors: { cpu: true, memory: true, gpu: true, vram: true }, theme: 'dark', experimental: {}, agent: {}, ui: {}, connectors: [] };
// What `background:state` answers; the integration sets it per capture.
let background = { running: 0, paused: 0, reason: null as string | null };
const bridge: any = {
  backgroundState: async () => background,
  getSystemStats: async () => ({ cpuPct: 18, cpuCores: 18, memUsedMB: 61_440, memTotalMB: 131_072 }),
  getGpuStats: async () => ({ source: 'ioreg', unified: true, totalMB: 131_072, usedMB: 9_800, freeMB: 121_272, devices: [{ name: 'Apple M5 Max', memoryTotalMB: 131_072, memoryUsedMB: 9_800, memoryFreeMB: 121_272, utilizationPct: 4 }] }),
  listWorkflows: async () => ({ workflows: [local, review], runs }),
  listModels: async () => [{ id: 'qwen3-8b', name: 'Qwen3 8B' }],
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'darwin' }),
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

type Scene = 'workflows' | 'editor' | 'pane' | 'modal' | 'settings' | 'paused' | 'hud' | 'dock';

function DockScene() {
  const [wall, setWall] = useState({ ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, show: true, side: 'right' as const, monitors: { ...DEFAULT_WALL_STATE.dock.monitors, hardware: true }, monitorOrder: ['hardware'] as any, minimized: {} } });
  return <div style={{ display: 'flex', height: 520, width: 460, margin: 24 }} data-dock-scene>
    <MonitorsDock state={wall as any} setState={setWall as any} tasks={[]} running={new Set()} now={NOW} sessions={[]} providers={[]} usage={null}
      vitals={{ working: 0, waiting: 0, automations: 1, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] } as any} onOpenChat={() => {}} onOpenModels={() => {}} />
  </div>;
}

/** A background reply that ran a command, started writing, and stepped aside for the user. */
function pausedReply() {
  const sessionId = `paused-${Date.now()}`;
  const ev = (e: object) => applyEvent({ sessionId, ...e } as any);
  ev({ type: 'text', delta: 'Checking yesterday’s commits. ' });
  ev({ type: 'tool_call', call: { id: 'c1', name: 'bash', input: { command: 'git log --since=yesterday --oneline' } } });
  ev({ type: 'tool_result', result: { toolCallId: 'c1', output: 'a1b2c3 Fix login\nd4e5f6 Bump deps' } });
  ev({ type: 'text', delta: 'Two commits landed: a login fix and a dependency bu' });
  ev({ type: 'retry', attempt: 1, maxAttempts: 5, delayMs: 0, reason: 'Paused while someone uses this computer', paused: true });
  return sessionId;
}

function PausedScene() {
  const [sessionId] = useState(pausedReply);
  const [, tick] = useState(0);
  React.useEffect(() => { const t = setTimeout(() => tick(1), 100); return () => clearTimeout(t); }, []);
  const run = getLiveRun(sessionId);
  return <div style={{ maxWidth: 760, margin: 24 }} className="card p-4">
    <p className="mb-3 text-[12px] text-ink-faint" data-paused-status>Status: {shortLiveStatus(run?.activity)} · Card: {describeLiveActivity(run?.activity)}</p>
    <LiveTurn sessionId={sessionId} held={null} />
  </div>;
}

function Fixture() {
  const [scene, setScene] = useState<Scene>('workflows');
  const [epoch, setEpoch] = useState(0);
  const show = (next: Scene) => {
    localStorage.clear();
    useStore.setState({ view: 'workflows', providers, models: [], sessions: [], terminals: [], workspaces: [], settings, settingsLoaded: true, installedSkillDefs: [] } as any);
    setScene(next);
    setEpoch((e) => e + 1);
  };
  const setBackground = (b: typeof background) => { background = b; };
  Object.assign(window, { integration: { show, setBackground, hasSettingsSection: typeof (Settings as any).AutomationsSection === 'function' } });
  const AutomationsSection = (Settings as any).AutomationsSection;
  return <div style={{ height: '100vh', overflow: 'auto' }} className="bg-paper" key={epoch} data-scene={scene}>
    {scene === 'workflows' && <WorkflowsView />}
    {scene === 'editor' && <WorkflowEditor workflow={local as any} workflows={[local as any]} skills={[]} onClose={() => {}} onSave={() => {}} />}
    {scene === 'pane' && <div style={{ width: 640, height: 360, margin: 24 }} className="card"><AutomationsPane tasks={tasks as any} running={new Set()} now={NOW} onOpen={() => {}} /></div>}
    {scene === 'modal' && <ScheduleTaskModal providerId="nekko-engine" modelId="qwen3-8b" initialPrompt="Summarize yesterday’s commits." onClose={() => {}} />}
    {scene === 'paused' && <PausedScene />}
    {scene === 'hud' && <div style={{ height: 300 }}><ResourceHud /></div>}
    {scene === 'dock' && <DockScene />}
    {scene === 'settings' && <div style={{ maxWidth: 760, margin: 24 }}>{AutomationsSection ? <AutomationsSection settings={settings} update={() => {}} /> : <p data-no-section>No Automations section on this revision.</p>}</div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

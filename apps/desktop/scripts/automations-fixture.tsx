import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { WorkflowsView } from '../src/renderer/views/WorkflowsView';
import * as Settings from '../src/renderer/views/SettingsView';
import { WorkflowEditor } from '../src/renderer/components/WorkflowEditor';
import { AutomationsPane } from '../src/renderer/components/AutomationsPane';
import { ScheduleTaskModal } from '../src/renderer/components/ScheduleTaskModal';
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
const settings = { providers, defaultProviderId: 'nekko-engine', defaultModelId: 'qwen3-8b', workspaceFolders: [], workspaces: [], monitors: {}, theme: 'dark', experimental: {}, agent: {}, ui: {}, connectors: [] };
const bridge: any = {
  listWorkflows: async () => ({ workflows: [local, review], runs }),
  listModels: async () => [{ id: 'qwen3-8b', name: 'Qwen3 8B' }],
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'darwin' }),
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

type Scene = 'workflows' | 'editor' | 'pane' | 'modal' | 'settings';

function Fixture() {
  const [scene, setScene] = useState<Scene>('workflows');
  const [epoch, setEpoch] = useState(0);
  const show = (next: Scene) => {
    localStorage.clear();
    useStore.setState({ view: 'workflows', providers, models: [], sessions: [], terminals: [], workspaces: [], settings, settingsLoaded: true, installedSkillDefs: [] } as any);
    setScene(next);
    setEpoch((e) => e + 1);
  };
  Object.assign(window, { integration: { show, hasSettingsSection: typeof (Settings as any).AutomationsSection === 'function' } });
  const AutomationsSection = (Settings as any).AutomationsSection;
  return <div style={{ height: '100vh', overflow: 'auto' }} className="bg-paper" key={epoch} data-scene={scene}>
    {scene === 'workflows' && <WorkflowsView />}
    {scene === 'editor' && <WorkflowEditor workflow={local as any} workflows={[local as any]} skills={[]} onClose={() => {}} onSave={() => {}} />}
    {scene === 'pane' && <div style={{ width: 640, height: 360, margin: 24 }} className="card"><AutomationsPane tasks={tasks as any} running={new Set()} now={NOW} onOpen={() => {}} /></div>}
    {scene === 'modal' && <ScheduleTaskModal providerId="nekko-engine" modelId="qwen3-8b" initialPrompt="Summarize yesterday’s commits." onClose={() => {}} />}
    {scene === 'settings' && <div style={{ maxWidth: 760, margin: 24 }}>{AutomationsSection ? <AutomationsSection settings={settings} update={() => {}} /> : <p data-no-section>No Automations section on this revision.</p>}</div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

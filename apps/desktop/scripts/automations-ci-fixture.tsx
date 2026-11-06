// Renderer-only fixture: no host, daemon, GitHub or real VM operations.
import '../src/renderer/../../scripts/wall-polish-chrome';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_RUNNER_SETTINGS, type RunnerView } from '@nekko-agent/shared';
import { AutomationsPane } from '../src/renderer/components/AutomationsPane';
import { WorkflowsView } from '../src/renderer/views/WorkflowsView';
import { useStore } from '../src/renderer/store';
import '../src/renderer/styles.css';

const now = Math.floor(Date.now() / 1000);
const job = { repo: 'example/app', runId: 41, jobId: 42, workflow: 'Native iOS', job: 'Build and test', url: 'https://github.com/example/app/actions/runs/41/job/42', steps: { done: 3, total: 8, current: 'Build iOS' } };
const initial: RunnerView = {
  config: { id: 'r1', scope: { kind: 'repo', owner: 'example', repo: 'app' }, label: 'nekko-cloud-mac', settings: { ...DEFAULT_RUNNER_SETTINGS, enabled: true, macosSlots: 2 } },
  state: 'running', reasons: [], available: 2, limit: null, awake: true, error: null,
  slots: [
    { state: 'running', vm: 'nekko-mac-01', job, since: now - 360, drainEndsAt: null },
    { state: 'ready', vm: 'nekko-mac-02', job: null, since: now - 60, drainEndsAt: null },
  ],
  queue: [{ ...job, jobId: 43, job: 'Next build', createdAt: new Date((now - 120) * 1000).toISOString(), accepted: false, declined: false }],
  recent: [{ ts: now - 600, runnerId: 'r1', repo: job.repo, workflow: 'Desktop', job: 'Unit tests', result: 'finished', seconds: 180, reason: [], jobId: 40, url: job.url, vm: 'nekko-mac-00' }],
  today: { jobs: 4, seconds: 900 }, repos: [], forkApprovalOpen: false, suggestedSize: null,
  host: { ramMb: 32768, cores: 10, recommendedMemoryMb: 16384, runnerMemoryMb: 16384, cpusPerVm: 4, onBattery: false, batteryPct: 100, networkId: 'trusted', networkTrusted: true },
};
let views = [initial];
let fail = '';
const listeners = new Set<(v: RunnerView[]) => void>();
const calls: unknown[] = [];
const push = () => listeners.forEach(cb => cb(views));
Object.assign(window, { nekko: {
  listRunners: async () => { if (fail) throw new Error(fail); return views; },
  onRunnersChanged: (cb: (v: RunnerView[]) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
  imageStatus: async () => { throw new Error('fixture has no image builder'); }, onImageChanged: () => () => {},
  runnerLiveLog: async (id: string, vm: string) => { calls.push(['log', id, vm]); return `${vm}: Listening for jobs\nBuild output`; },
  runnerJobLog: async () => 'Tests passed', runnerVmLog: async () => 'VM shut down',
  runnerJob: async (...args: unknown[]) => { calls.push(args); },
  setRunnerEnabled: async (id: string, enabled: boolean) => { calls.push(['enabled', id, enabled]); views = views.map(v => ({ ...v, config: { ...v.config, settings: { ...v.config.settings, enabled } } })); push(); return views[0]; },
  openPath: async (url: string) => { calls.push(['open', url]); },
  listWorkflows: async () => ({ workflows: [], runs: [] }), onWorkflowsUpdated: () => () => {},
  engineStatus: async () => null,
} });
localStorage.setItem('nekko.chatMode', 'expert');
useStore.setState({ view: 'command', settings: {} as never });
let epoch = 0;
const root = createRoot(document.getElementById('root')!);
function Surface() {
  const view = useStore(s => s.view);
  return <main className="h-full overflow-hidden bg-paper text-ink"><header className="border-b border-line p-3 text-sm font-semibold">Automations</header><div style={{ height: 'calc(100% - 45px)' }}>{view === 'workflows' ? <WorkflowsView /> : <AutomationsPane tasks={[]} running={new Set()} now={now * 1000} onOpen={() => {}} />}</div></main>;
}
const show = (scene = 'active') => {
  fail = scene === 'error' ? 'Service disconnected' : scene === 'unsupported' ? 'unknown channel runner:list' : '';
  views = scene === 'empty' ? [] : [structuredClone(initial)];
  useStore.setState({ view: 'command' });
  root.render(<Surface key={++epoch} />);
};
Object.assign(window, { integration: { show, calls, full: () => useStore.setState({ view: 'workflows' }), pushEmpty: () => { views = []; push(); }, listenerCount: () => listeners.size } });
show();

import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { WorkflowsView } from '../src/renderer/views/WorkflowsView';
import { DEFAULT_RUNNER_SETTINGS, IDLE_GITHUB_SETUP, type AuditLine, type GithubAccounts, type GithubSetupView, type HostView, type ImagePlan, type ImageView, type RunnerView } from '@nekko-agent/shared';
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
    id: 'r1', scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' }, label: 'nekko-cloud-mac',
    settings: { ...DEFAULT_RUNNER_SETTINGS, enabled: true, macosSlots: 2, trustedNetworks: ['gw:a4:83:e7:1c:22:9f'], ...settings },
  },
  state: 'ready', slots: [], reasons: [], available: 2, limit: null, awake: false, error: null,
  today: { jobs: 0, seconds: 0 }, host, repos: [], forkApprovalOpen: false, recent: [], ...over,
});
const off = (over: Partial<RunnerView> = {}) => view({ state: 'off', reasons: ['off'], ...over }, { enabled: false, macosSlots: 1 });
// The daemon reports the missing image on a switched-off runner too.
const offNoImage = () => off({ error: 'No VM image yet.' });
const noImageYet = () => [view({ state: 'error', error: 'No VM image yet.' }, { macosSlots: 1 })];

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
  'connect-step-1': async () => [],
  'connect-step-3': async () => [],
  'github-account': async () => [],
  'github-account-no-gh': async () => [],
  'github-free-org': async () => [],
  'github-waiting': async () => [],
  'github-confirm': async () => [],
  'github-confirm-public': async () => [],
  'github-handoff': async () => [],
  'github-fork': async () => [],
  'github-fork-on': async () => [],
  'github-fork-left-off': async () => [],
  'first-visit-connected': async () => [offNoImage()],
  'setup-plan': async () => [offNoImage()],
  'setup-no-xcode': async () => [offNoImage()],
  'setup-download': async () => noImageYet(),
  'setup-install': async () => noImageYet(),
  'setup-waiting': async () => noImageYet(),
  'setup-cancel': async () => noImageYet(),
  'setup-failed': async () => noImageYet(),
  'setup-refused-macos': async () => noImageYet(),
  'setup-refused-helper': async () => noImageYet(),
  'setup-resume': async () => noImageYet(),
  'setup-rebuild': async () => [view({})],
  ready: async () => [view({})],
  'ready-left-off': async () => [off({ forkApprovalOpen: true })],
  'ready-second-runner': async () => [off()],
  'rebuild-cancelled': async () => [view({})],
  'connect-busy': async () => [],
  'image-retry': async () => [offNoImage()],
  'card-ready': async () => [view({ today: { jobs: 3, seconds: 41 * 60 } })],
  settings: async () => [view({ limit: 'memory', available: 1 })],
  'settings-bottom': async () => [view({ limit: 'memory', available: 1 })],
  'settings-unsampled': async () => [view({ host: unsampled, state: 'waiting', reasons: ['hostStateUnknown'] })],
};

const image = (over: Partial<ImageView> = {}): ImageView => ({
  state: 'none', stage: null, doneStages: [], detail: '', bytes: null, fraction: null, error: null, log: null, info: null, canResume: false, ...over,
});
const READY = image({ state: 'ready', info: { macos: '27.2', xcode: '27.2', actionsRunner: '2.330.0', built: '2026-11-01' } });
const NONE = image();
const toXcode: ImageView['doneStages'] = ['check', 'download', 'install'];
const download = image({ state: 'building', stage: 'download', doneStages: ['check'], bytes: [12_400_000_000, 25_600_000_000] });
const images: Record<string, ImageView | null> = {
  // A daemon with no builder: the card keeps its error line.
  error: null,
  'first-visit': NONE, 'connect-step-1': NONE, 'connect-step-3': NONE,
  'github-account': NONE, 'github-account-no-gh': NONE, 'github-free-org': NONE, 'github-waiting': NONE, 'github-confirm': NONE, 'github-confirm-public': NONE,
  'github-handoff': READY, 'github-fork': NONE, 'github-fork-on': NONE, 'github-fork-left-off': NONE,
  'first-visit-connected': NONE, 'setup-plan': NONE, 'setup-no-xcode': NONE,
  'setup-download': download, 'setup-cancel': download,
  'setup-install': image({ state: 'building', stage: 'install', doneStages: ['check', 'download'], fraction: 0.48 }),
  'setup-waiting': image({ state: 'waiting', stage: 'install', doneStages: ['check'], detail: 'Waiting for a free VM slot' }),
  'setup-failed': image({ state: 'failed', stage: 'xcode', doneStages: toXcode, error: 'This Mac has 18 GB free. Free up 42 GB, then try again.', log: 'runner image: Install took 240 s\nCannot copy Xcode: no space left on device', canResume: true }),
  'setup-refused-macos': image({ state: 'failed', stage: 'check', error: 'Update this Mac to macOS 27 to set it up here.', canResume: true }),
  'setup-refused-helper': image({ state: 'failed', stage: 'check', error: 'This copy of Nekko cannot build a VM on its own. Update Nekko, or bring your own image.', canResume: true }),
  'setup-resume': image({ stage: 'xcode', doneStages: toXcode, canResume: true }),
  'setup-rebuild': READY, ready: download, 'ready-left-off': download, 'ready-second-runner': download, 'card-ready': READY,
  'rebuild-cancelled': image({ ...download, info: READY.info }), 'connect-busy': NONE, 'image-retry': NONE,
};
const plans: Record<string, ImagePlan> = { 'setup-no-xcode': { xcode: null, freeGb: 369.4, needsGb: 110 } };
const PLAN: ImagePlan = { xcode: '27.2', freeGb: 369.4, needsGb: 110 };

const signedIn: GithubAccounts = { login: 'ermish', accounts: [
  { login: 'nekko-labs', kind: 'org', canGroup: true },
  { login: 'free-org', kind: 'org', canGroup: false },
  { login: 'ermish', kind: 'user', canGroup: null },
] };
const app = (over: Partial<GithubSetupView>): GithubSetupView => ({
  ...IDLE_GITHUB_SETUP, step: 'confirm', owner: 'nekko-labs', kind: 'org', slug: 'nekko-runner-nekko-labs-3fa9', appId: 1048576, installationId: 58210934,
  repos: [{ name: 'nekko-labs/nekko-agent', private: true }, { name: 'nekko-labs/nekko-site', private: true }, { name: 'nekko-labs/models', private: true }], ...over,
});
const publicApp = app({ repos: [{ name: 'nekko-labs/nekko-agent', private: false }, { name: 'nekko-labs/nekko-site', private: true }] });
const github: Record<string, GithubSetupView> = {
  'github-waiting': app({ step: 'install', repos: [], installationId: null }),
  'github-confirm': app({}),
  'github-handoff': app({}),
  'connect-busy': app({}),
  'github-confirm-public': publicApp,
  'github-fork': publicApp,
  'github-fork-on': publicApp,
  'github-fork-left-off': publicApp,
};

let scene = 'first-visit';
let imageChanged: (v: ImageView) => void = () => {};
let runnersChanged: (v: RunnerView[]) => void = () => {};
let imageRefused = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settings = { providers: [], workspaceFolders: [], workspaces: [], monitors: {}, theme: 'dark', experimental: {}, agent: {}, ui: {}, connectors: [] };
const bridge: any = {
  listRunners: () => scenes[scene](),
  githubAccounts: async () => (scene === 'github-account-no-gh' ? { login: null, accounts: [] } : signedIn),
  githubStatus: async () => github[scene] ?? IDLE_GITHUB_SETUP,
  connectRunner: async () => { if (scene === 'connect-busy') await sleep(1500); return off(); },
  setRunnerEnabled: async () => view({}),
  imageStatus: async () => {
    // A daemon that is not ready for the first call, as at launch.
    if (scene === 'image-retry' && !imageRefused) { imageRefused = true; throw new Error('not yet'); }
    return scene in images ? images[scene] : READY;
  },
  cancelImage: async () => { imageChanged(READY); return READY; },
  imagePlan: async () => plans[scene] ?? PLAN,
  onImageChanged: (cb: (v: ImageView) => void) => { imageChanged = cb; return () => {}; },
  onRunnersChanged: (cb: (v: RunnerView[]) => void) => { runnersChanged = cb; return () => {}; },
  setForkApproval: async () => ({ done: false, url: 'https://github.com/nekko-labs/nekko-agent/settings/actions' }),
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
  Object.assign(window, { integration: { show, finishBuild: () => imageChanged(READY), pushRunners: () => runnersChanged([offNoImage()]) } });
  return <div style={{ height: '100vh', overflow: 'auto' }} className="bg-paper" key={epoch} data-scene={scene}><WorkflowsView /></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

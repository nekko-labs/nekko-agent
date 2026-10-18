import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { TitleBar } from '../src/renderer/components/TitleBar';
import { UpdateProvider } from '../src/renderer/components/UpdateBanner';
import { ReplyStatus } from '../src/renderer/components/agent-console/ReplyStatus';
import { Mascot, NekkoAvatar } from '../src/renderer/components/Mascot';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { summarizeSession } from '@nekko-agent/shared';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
// A local runtime, so the agent window's internet toggle can block it.
const provider = { id: 'fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.now();
const makeSession = (id: string, title: string, workspaceId?: string) => ({
  id, title, createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', workspaceId,
  messages: [
    { id: id + '-u', role: 'user', content: 'Summarise the synthetic fixture.', createdAt: at - 60_000 },
    { id: id + '-a', role: 'assistant', content: 'The synthetic fixture renders two agent windows and one chat that is not on the wall.', createdAt: at - 30_000,
      turnStats: { providerId: 'fixture', modelId: 'claude-opus-5-5', effort: 'medium', inputTokens: 39650, cacheReadTokens: 32_601_512, cacheWriteTokens: 642_691, outputTokens: 25540, outputMs: 164387, wallMs: 681582, calls: 53, steps: 53, stop: 'complete' } },
  ],
  attachments: [], queuedPrompts: [],
});
// Synthetic daily usage for the Budget panel: today, last week, two months ago.
const day = (offset: number) => new Date(at - offset * 86_400_000).toISOString().slice(0, 10);
const usageFixture = () => ({
  totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, byProvider: {}, bySession: {}, bySessionCost: { alpha: 2.4 },
  daily: [{ date: day(0), input: 12000, output: 3400, cost: 0.42 }, { date: day(5), input: 80000, output: 21000, cost: 1.9 }, { date: day(60), input: 400000, output: 90000, cost: 7.5 }],
  avoidedCosts: { local: 1.23, subscription: 4.56 },
});
let records: any[] = [];
// Optional: what each session is waiting on a person for (a question on the wall).
let pendingFixture: Record<string, any> = {};
let expiredFixture = false;
const claude = { id: 'claude-sub', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', enabled: true, label: 'Claude subscription', auth: 'subscription', tokenKey: 'claude' };
const calls: any[] = [];
const bridge: any = {
  createSession: async (workspaceId: string) => { calls.push({ method: 'create', workspaceId }); const s = makeSession(`new-${records.length}`, 'New chat', workspaceId); records.push(s); return s; },
  setSessionOptions: async (id: string, options: any) => { calls.push({ method: 'options', id, options }); const s = records.find(s => s.id === id); Object.assign(s, options); return { ...s }; },
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => [],
  getSession: async (id: string) => records.find(s => s.id === id), listModels: async () => models,
  getUsageSummary: async () => usageFixture(), pendingInput: async () => pendingFixture, runningSessions: async () => [],
  listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'win32' }), getUpdateInfo: async () => null,
  listTools: async () => [{ name: 'read_file', description: 'Read a file' }, { name: 'bash', description: 'Run a command' }], getMcpStatus: async () => [], listSkills: async () => [],
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
  // opts.expired: the Claude subscription's sign-in has expired.
  getLimitsProblem: async (key: string) => (expiredFixture && key === 'claude' ? { kind: 'auth_expired', at: Date.now() } : null),
  getLimits: async () => null,
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function StatusGallery() {
  const now = Date.now();
  const base = { streaming: false, status: '', elapsed: 0, tps: 0, out: 1300, last: { out: 1300, tps: 0, secs: 61 }, now };
  return <div style={{ padding: 24, width: 520 }} className="space-y-6 bg-paper">
    <ReplyStatus {...base} nextWakeAt={now + 13 * 60_000} />
    <ReplyStatus {...base} done="Done" />
  </div>;
}

/** The Spooky corner mascot (with its hat) and the nav rail's Agents cat, large enough to inspect. */
function MascotGallery() {
  return <div style={{ padding: 24, display: 'flex', gap: 48, alignItems: 'flex-end' }} className="bg-paper" data-mascot-gallery>
    <div data-gallery="hat"><NekkoAvatar size={192} stationary quiet wizardHat /></div>
    <div data-gallery="nav" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <span className="nav-item active" style={{ display: 'grid', placeItems: 'center', width: 44, height: 44 }}><NekkoAvatar size={22} stationary eyes={false} /></span>
      <NekkoAvatar size={132} stationary eyes={false} />
    </div>
    <Mascot mood="idle" enabled wizardHat />
  </div>;
}

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const [route, setRoute] = useState('command');
  // opts: empty wall, show the dock (Budget only), theme preset, horizontal agent panel.
  // opts.question: beta waits on a question. opts.many: enough grouped chats to
  // overflow the panel. opts.resumable: alpha ends on an assistant reply with work.
  // opts.plan: alpha carries an agent plan; opts.expired: the dock shows Utilization with an expired sign-in.
  // opts.dockAll: a right-side dock with four panels to reorder.
  const reset = (opts: { empty?: boolean; dock?: boolean; dockAll?: boolean; preset?: string; horizontal?: boolean; question?: boolean; many?: boolean; plan?: boolean; planOpen?: boolean; expired?: boolean; focus?: boolean } = {}) => {
    expiredFixture = !!opts.expired;
    records = [makeSession('alpha', 'Fix wall and composer styling', opts.many ? 'ws-a' : undefined), makeSession('beta', 'Analyze post-merge perf trace', opts.many ? 'ws-a' : undefined), makeSession('outside', 'Chat not on the wall')];
    if (opts.many) for (let i = 0; i < 18; i++) records.push(makeSession(`extra-${i}`, `Grouped chat ${i + 1}`, i % 2 ? 'ws-a' : 'ws-b'));
    pendingFixture = opts.question ? { beta: { sessionId: 'beta', question: { callId: 'ask1', askedAt: Date.now(), questions: [{ id: 'q1', header: 'Branch', question: 'Which branch should I use?', options: [{ label: 'main' }, { label: 'dev' }] }] } } } : {};
    if (opts.plan) records[0].agentPlan = [{ id: 's1', title: 'Restore the needs-you ring', status: 'done' }, { id: 's2', title: 'Pin the question at the top of the window', status: 'active' }, { id: 's3', title: 'Floating plan toggle', status: 'pending' }];
    calls.length = 0;
    localStorage.clear();
    const root = opts.empty ? null : { id: 'split', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'pane-alpha', kind: 'chat', refId: 'alpha' }, { id: 'pane-beta', kind: 'chat', refId: 'beta' }] };
    const dock = opts.dockAll ? { ...DEFAULT_WALL_STATE.dock, show: true, side: 'right', monitorOrder: ['vitals', 'hardware', 'budget', 'utilization', 'automations', 'insights'], panels: { vitals: true, automations: false, utilization: true, budget: true, insights: false, hardware: true } }
      : opts.dock || opts.expired ? { ...DEFAULT_WALL_STATE.dock, show: true, panels: { vitals: false, automations: false, utilization: !!opts.expired, budget: !opts.expired, insights: false, hardware: false } } : { ...DEFAULT_WALL_STATE.dock, show: false };
    const agentPanel = opts.horizontal ? { show: true, orientation: 'horizontal' } : undefined;
    useStore.setState({ view: 'command', providers: opts.expired ? [provider, claude] : [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: null, settings: { providers: opts.expired ? [provider, claude] : [provider], workspaceFolders: [], workspaces: opts.many ? [{ id: 'ws-a', name: 'nekko-agent', path: 'C:/fixture/a' }, { id: 'ws-b', name: 'mynichi', path: 'C:/fixture/b' }] : [], theme: 'dark', themePreset: opts.preset, experimental: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, root, hero: opts.empty ? null : 'alpha', autoAdd: false, watermark: Date.now(), dock, ...(opts.focus ? { layout: { ...DEFAULT_WALL_STATE.layout, mode: 'focus' } } : {}), ...(agentPanel ? { agentPanel } : {}) } }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: !!opts.planOpen } as any);
    records.forEach(putCachedSession); setRoute('command'); setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, calls, route: setRoute, state: () => useStore.getState(), records: () => records } });
  React.useEffect(reset, []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <UpdateProvider><TitleBar /></UpdateProvider>
    <main style={{ flex: 1, minHeight: 0 }}>{route === 'command' ? <CommandCenterView /> : route === 'mascot' ? <MascotGallery /> : <StatusGallery />}</main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

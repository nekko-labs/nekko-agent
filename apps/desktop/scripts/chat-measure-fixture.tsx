import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { clearLiveRun } from '../src/renderer/liveRuns';
import { ChatPane } from '../src/renderer/components/ChatPane';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
//
// One reply that mixes prose with a wide table and a code block, so a capture
// shows whether the prose and the table share one column edge.
const provider = { id: 'fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.now() - 3_600_000;

const reply = [
  'I checked each claim in the pull request against the code on main and against the live API. Every one of them holds, and the table below lists what I ran for each.',
  '',
  '| Claim | Check |',
  '| --- | --- |',
  '| The API answers 403 without a User-Agent | **True.** A request to the exact release URL returns 403 without the header and 200 with `User-Agent: nekko-agent`. |',
  '| The installer request had no User-Agent | **True.** The diff adds only that header, and main still sends it. No HTTP client in the project sets a default one. |',
  '| The other installer already sent one | **True.** It sends `user-agent: nekko-agent` on the same kind of request. |',
  '| The engine tests pass | **True.** They all pass on main, and removing the header makes the install test fail. |',
  '',
  'The pull request says it did not run a full install from the app, and neither did I. The cause and the fix are both confirmed against the real API, though, so the risk left is small and the issue can be closed as fixed by that pull request.',
  '',
  '```ts',
  'const headers = { Accept: "application/vnd.github+json", "User-Agent": "nekko-agent" };',
  '```',
  '',
  'That is everything this check needed.',
].join('\n');

function makeSession() {
  const messages = [
    { id: 'u1', role: 'user', content: 'Check whether this pull request really fixes the issue, and show me what you ran for each claim it makes.', createdAt: at },
    { id: 'a1', role: 'assistant', content: reply, createdAt: at + 5000 },
  ];
  return { id: 'alpha', title: 'Reply column', createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages, attachments: [], queuedPrompts: [] };
}

let record: any = makeSession();
const bridge: any = {
  getSession: async () => record, listModels: async () => models, listSessionSummaries: async () => [], listTerminals: async () => [],
  getUsageSummary: async () => ({ totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, byProvider: {}, bySession: {}, bySessionCost: {}, daily: [] }),
  pendingInput: async () => ({}), runningSessions: async () => [], listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'win32' }), getUpdateInfo: async () => null,
  listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [], getLimitsProblem: async () => null, getLimits: async () => null,
  nextAgentWatchAt: async () => null,
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const reset = () => {
    clearLiveRun('alpha');
    record = makeSession();
    localStorage.clear();
    useStore.setState({ view: 'chat', providers: [provider], models, activeProviderId: 'fixture', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: 'alpha', activeProjectId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: {} }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    putCachedSession(record);
    setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset } });
  React.useEffect(() => reset(), []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <main style={{ flex: 1, minHeight: 0 }}><ChatPane sessionId="alpha" /></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

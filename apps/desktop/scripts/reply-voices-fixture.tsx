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
// One working turn with thinking, progress notes, a question left mid-turn and
// a closing wrap-up, then a plain follow-up, so a capture shows which text reads
// as the agent working and which reads as the agent talking to you.
const provider = { id: 'fixture', kind: 'openai', baseUrl: 'https://api.example.test', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.now() - 3_600_000;

const wrapUp = [
  'The login test no longer depends on timing. It passed 50 runs in a row on a slowed-down machine.',
  '',
  '**Changes**',
  '- `tests/login.test.ts` waits for the session event instead of a fixed timer.',
  '- `tests/helpers/session.ts` gains a `waitForSession` helper.',
  '',
  '**Verified**: 50 local runs with the CPU throttled four times, all green.',
  '',
  '**Not verified / blocked**: the Windows runner, which only runs in the merge queue.',
  '',
  '**Decision**: I kept the five second overall timeout, because a real hang should still fail fast.',
  '',
  '**Run this**',
  '```bash',
  'npm test -- login --repeat 50',
  '```',
  '',
  '**Next step**: confirm the signup question above, then I will open the PR.',
].join('\n');

const call = (id: string, name: string, input: any) => ({ id, name, input });
const result = (id: string, callId: string, output: string, createdAt: number) => ({ id, role: 'tool', content: '', createdAt, toolResult: { toolCallId: callId, output } });

function makeSession() {
  const messages = [
    { id: 'u1', role: 'user', content: 'The login test keeps failing in CI. Find out why and fix it.', createdAt: at },
    { id: 'a1', role: 'assistant', reasoning: 'A test that fails only on CI usually means timing. I should read the test before guessing, then compare the failed runs.', reasoningSeconds: 4, content: 'I will start with the test itself and its last three CI runs.', toolCalls: [call('c1', 'read_file', { path: 'tests/login.test.ts' }), call('c2', 'grep', { pattern: 'setTimeout', path: 'tests' })], createdAt: at + 1000 },
    result('t1', 'c1', 'ok', at + 2000), result('t2', 'c2', 'ok', at + 2100),
    { id: 'a2', role: 'assistant', content: 'The test waits a fixed 200 ms for the session, so a slow runner misses it. I am replacing the timer with a wait on the session event.', toolCalls: [call('c3', 'edit_file', { path: 'tests/login.test.ts' })], createdAt: at + 3000 },
    result('t3', 'c3', 'ok', at + 4000),
    { id: 'a3', role: 'assistant', content: 'The signup test has the same timer.\n\nShould I fix that one here too, or leave it for its own PR?', toolCalls: [call('c4', 'bash', { command: 'npm test -- login --repeat 50' })], createdAt: at + 5000 },
    result('t4', 'c4', 'ok', at + 6000),
    { id: 'a4', role: 'assistant', reasoning: 'Fifty clean runs under throttling is strong enough. Windows only runs in the queue, so I should say that plainly.', reasoningSeconds: 2, content: wrapUp, createdAt: at + 7000 },
    { id: 'u2', role: 'user', content: 'What fires the session event?', createdAt: at + 8000 },
    { id: 'a5', role: 'assistant', content: 'The auth client fires it once the token is stored, so it is safe to read the session as soon as it arrives.', createdAt: at + 9000 },
  ];
  return { id: 'alpha', title: 'Fix the login test', createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages, attachments: [], queuedPrompts: [] };
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

import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { applyEvent, clearLiveRun } from '../src/renderer/liveRuns';
import { ChatPane } from '../src/renderer/components/ChatPane';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
//
// Reproduces a reply drawn twice: the daemon checkpoints the transcript after
// every tool result, so mid-turn the persisted chat ends with an assistant
// message that narrated and then called tools. The pane re-reads it on
// `session_meta` while the live run below still holds the same narration.
const provider = { id: 'fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.now();
const NARRATION = "I'll start by reading the workspace guidance in `obsurdian/AGENTS.md`, then locate the Nekko Agent project and its open PRs.";
const calls = [
  { id: 'c1', name: 'set_chat_title', input: { title: 'Finish draft PRs, fix verification drop-off' } },
  { id: 'c2', name: 'read_file', input: { path: 'C:/Users/phili/code/obsurdian/AGENTS.md' } },
  { id: 'c3', name: 'list_dir', input: { path: 'C:/Users/phili/code' } },
];
const makeSession = (running: boolean) => ({
  id: 'alpha', title: 'Finish draft PRs, fix verification drop-off', createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal',
  ...(running ? { activeRun: { startedAt: at - 5_000 } } : {}),
  messages: [
    { id: 'u', role: 'user', content: 'finish up the remaining PRs from myself and BobbyRobBob.', createdAt: at - 60_000 },
    // The checkpoint after the three tool results: narration + tool calls, no answer yet.
    { id: 'a1', role: 'assistant', content: NARRATION, createdAt: at - 5_000, toolCalls: calls },
    ...calls.map((c, i) => ({ id: `t${i}`, role: 'tool', content: '', createdAt: at - 4_000 + i, toolResult: { toolCallId: c.id, output: 'ok' } })),
  ],
  attachments: [], queuedPrompts: [],
});
let record: any = makeSession(true);
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
  // `running`: the turn is in flight. The live run holds the same narration and
  // the three tool calls; the next model call has not produced text yet.
  const reset = (opts: { running?: boolean } = {}) => {
    clearLiveRun('alpha');
    record = makeSession(!!opts.running);
    localStorage.clear();
    useStore.setState({ view: 'chat', providers: [provider], models, activeProviderId: 'fixture', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: 'alpha', activeProjectId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: {} }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    putCachedSession(record);
    if (opts.running) {
      const now = Date.now();
      applyEvent({ type: 'text', sessionId: 'alpha', delta: NARRATION } as any, now);
      for (const call of calls) applyEvent({ type: 'tool_call', sessionId: 'alpha', call } as any, now);
      for (const call of calls) applyEvent({ type: 'tool_result', sessionId: 'alpha', result: { toolCallId: call.id, output: 'ok' } } as any, now);
      applyEvent({ type: 'tool_call', sessionId: 'alpha', call: { id: 'c4', name: 'bash', input: { command: 'git status --short' } } } as any, now);
    }
    setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, state: () => useStore.getState() } });
  React.useEffect(() => reset({ running: true }), []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <main style={{ flex: 1, minHeight: 0 }} data-live-reply-fixture><ChatPane sessionId="alpha" /></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

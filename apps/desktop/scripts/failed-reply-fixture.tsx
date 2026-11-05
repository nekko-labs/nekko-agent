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
// A chat as it opens after a restart: the last turn failed right after a tool
// finished, so the transcript itself looks finished and only `turnFailure`
// says otherwise.
const provider = { id: 'fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, label: 'Fixture provider', auth: 'subscription' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.UTC(2026, 10, 4, 15, 0);
const FAILURE = "You've hit your usage limit.";

function makeSession(afterMessageId: string) {
  const call = { id: 'c1', name: 'grep', input: { pattern: 'swipe' } };
  return {
    id: 'alpha', title: 'Failed reply fixture', createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent',
    messages: [
      { id: 'u1', role: 'user', content: 'Why does dragging left still swipe?', createdAt: at },
      { id: 'a1', role: 'assistant', content: 'Checking both builds.', createdAt: at + 1000, toolCalls: [call] },
      { id: 't1', role: 'tool', content: '', createdAt: at + 2000, toolResult: { toolCallId: call.id, output: 'timestampSwipe.ts' } },
    ],
    turnFailure: { message: FAILURE, afterMessageId },
  };
}

let record: any = makeSession('t1');
const calls: any[] = [];
const bridge: any = {
  getSession: async () => record, listModels: async () => models, listSessionSummaries: async () => [], listTerminals: async () => [],
  getUsageSummary: async () => ({ totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, byProvider: {}, bySession: {}, bySessionCost: {}, daily: [] }),
  pendingInput: async () => ({}), runningSessions: async () => [], listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'win32' }), getUpdateInfo: async () => null,
  listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [], getLimitsProblem: async () => null, getLimits: async () => null,
  nextAgentWatchAt: async () => null,
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
  setSessionOptions: async (id: string, patch: any) => { calls.push({ id, patch }); record = { ...record, ...patch }; return record; },
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  /** A fresh pane on `next`, the way a chat opens after a restart. */
  const open = (next: any) => {
    clearLiveRun('alpha');
    record = next;
    calls.length = 0;
    localStorage.clear();
    useStore.setState({ view: 'chat', providers: [provider], models, activeProviderId: 'fixture', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: 'alpha', activeProjectId: null, settings: { providers: [provider], workspaces: [] } } as never);
    putCachedSession(record);
    setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: {
    failed: () => open(makeSession('t1')),
    movedOn: () => open(makeSession('a-message-that-was-deleted')),
    reopen: () => open(record),
    calls: () => calls,
  } });
  React.useEffect(() => open(makeSession('t1')), []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <main style={{ flex: 1, minHeight: 0 }}><ChatPane sessionId="alpha" /></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

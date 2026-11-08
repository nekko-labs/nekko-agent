import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { applyEvent, getLiveRun, runningSessionIds } from '../src/renderer/liveRuns';
import { ChatPane } from '../src/renderer/components/ChatPane';
import '../src/renderer/styles.css';

// Synthetic records only: no daemon, account, or provider connection.
const provider = { id: 'fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, label: 'Fixture provider', auth: 'subscription' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.UTC(2026, 10, 4, 15, 0);
// Keep the elapsed clock deterministic in matched base/head captures.
Date.now = () => at + 541100;
const FAILURE = "You've hit your usage limit.";

const record: any = {
  id: 'alpha', title: 'Late usage recovery', createdAt: at, updatedAt: at,
  providerId: 'fixture', modelId: 'fixture-model', mode: 'agent',
  messages: [{ id: 'u1', role: 'user', content: 'Check the project and explain what needs fixing.', createdAt: at }],
  turnFailure: { message: FAILURE, afterMessageId: 'u1' },
};
// The API error arrives while this chat is unmounted; Claude Code's result
// then sends accounting without repeating the already-delivered error.
applyEvent({ type: 'error', sessionId: 'alpha', message: FAILURE }, at + 1000);
applyEvent({ type: 'usage', sessionId: 'alpha', inputTokens: 1000, outputTokens: 300, outputMs: 9000 }, at + 1100);

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
  setSessionOptions: async (id: string, patch: any) => { calls.push({ id, patch }); return { ...record, ...patch }; },
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

localStorage.clear();
useStore.setState({ view: 'chat', providers: [provider], models, activeProviderId: 'fixture', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: 'alpha', activeProjectId: null, settings: { providers: [provider], workspaces: [] } } as never);
putCachedSession(record);
Object.assign(window, { integration: {
  running: () => runningSessionIds(),
  nextTurn: () => applyEvent({ type: 'text', sessionId: 'alpha', delta: 'A genuine new reply.' }),
  text: () => getLiveRun('alpha')?.text,
} });
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper">
    <main style={{ flex: 1, minHeight: 0 }}><ChatPane sessionId="alpha" /></main>
  </div>,
);

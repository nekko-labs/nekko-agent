import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { AgentSidebar } from '../apps/desktop/src/renderer/views/WorkspacesView';
import { applyEvent } from '../apps/desktop/src/renderer/liveRuns';
import * as background from '../apps/desktop/src/renderer/components/ClaudeBackgroundTasks';
import '../apps/desktop/src/renderer/styles.css';

// Synthetic sessions only. No host, credentials, tools or network. A Claude
// Agent chat ended its turn while two background sub-agents work (#2840).
const now = Date.now();
const sessions = [
  { id: 'parent', title: 'Work through the 20 oldest issues', phase: 'building' },
  { id: 'triage', title: 'Triage issues 1635-1776', parentSessionId: 'parent' },
  { id: 'drawer', title: 'Fix #1909 narrow Agents drawer', parentSessionId: 'parent' },
  { id: 'other', title: 'Release notes for 0.9.8' },
].map((s) => ({ ...s, createdAt: now - 60000, updatedAt: now - 60000, prUrls: [], messageCount: 2, exchangeCount: 1, providerId: 'fixture', modelId: 'opus' }));
const kids = sessions.filter((s) => s.parentSessionId === 'parent');
const workspace = (id: string) => ({ id: `ws_${id}`, anchor: { kind: 'chat', refId: id }, root: { id: `pane_${id}`, kind: 'chat', refId: id }, activePaneId: `pane_${id}` });
const answers: Record<string, unknown> = { pendingInput: {}, runningSessions: ['triage', 'drawer'], claudeBackgroundTasks: { parent: 3 } };
Object.assign(window, { nekko: new Proxy({}, { get: (_t, k: string) => k.startsWith('on') ? () => () => {} : () => Promise.resolve(k in answers ? answers[k] : []) }) });
useStore.setState({ sessions, workspaces: sessions.filter((s) => !s.parentSessionId).map((s) => workspace(s.id)), terminals: [], settings: { workspaces: [], showTips: false }, refreshSessions: async () => {}, refreshTerminals: async () => {}, refreshSettings: async () => {} } as any);
// What each sub-agent is doing, as its own chat's events say.
applyEvent({ type: 'tool_call', sessionId: 'triage', call: { id: 'c1', name: 'Bash', input: { command: 'gh issue view 1644 --comments' } } } as any);
applyEvent({ type: 'reasoning', sessionId: 'drawer', delta: 'The drawer clips at 360px.' } as any);

const mod = background as any;
function Footer() {
  return mod.ChatBackgroundWork ? <mod.ChatBackgroundWork tasks={3} subAgents={kids} /> : <mod.ClaudeBackgroundTasks tasks={3} />;
}
createRoot(document.getElementById('root')!).render(
  <main className="bg-paper" style={{ height: '100vh', display: 'flex' }}>
    <div style={{ width: 340, flexShrink: 0, height: '100%' }}><AgentSidebar selectedId="parent" onOpenChat={() => {}} /></div>
    <section className="text-sm text-ink" style={{ flex: 1, padding: 32, maxWidth: 720 }}>
      <p className="text-ink-soft">…While the triage runs: the workspace repo has nothing unpushed.</p>
      <p className="mt-1 text-2xs text-ink-faint">opus · high · 6.0k output tokens · 1m 27s</p>
      <div className="mt-5" data-footer><Footer /></div>
    </section>
  </main>,
);

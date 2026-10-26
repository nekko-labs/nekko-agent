import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { clearLiveRun } from '../src/renderer/liveRuns';
import { ChatPane } from '../src/renderer/components/ChatPane';
import { SHORTCUTS } from '../src/renderer/shortcuts';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
//
// A long chat (well past one screen, so most rows are not rendered) with a
// known number of whole-word, case-insensitive occurrences of "scroll", mixed
// with partial words that must not match (scroller, autoscroll, scrolled), a
// link target that is not shown, and a tool call whose name and output are not
// message text.
const provider = { id: 'fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.UTC(2026, 9, 25, 12, 0);
const TURNS = 60;

function reply(i: number): string {
  const parts = [`## Step ${i}`, `Looking at the layout. The scroller and autoscroll code both changed; the list scrolled once.`];
  // Every 5th reply mentions the word, in a different case, inside formatting.
  if (i % 5 === 0) parts.push(`The **Scroll** position is what we fix here. ${i % 10 === 0 ? 'SCROLL again.' : ''}`);
  if (i % 7 === 0) parts.push('See [the scroll guide](https://example.invalid/scroll) for details.');
  if (i % 3 === 0) parts.push('```ts\nconst offset = 0; // no keyword here\n```');
  return parts.join('\n\n');
}

function makeSession() {
  const messages: any[] = [];
  for (let i = 0; i < TURNS; i++) {
    messages.push({ id: `u${i}`, role: 'user', content: i === 3 ? 'Why does the chat scroll back? I scroll down and it bounces.' : `Question ${i}`, createdAt: at + i * 20_000 });
    if (i % 4 === 0) {
      const call = { id: `c${i}`, name: 'grep', input: { pattern: 'scroll' } };
      messages.push({ id: `a${i}x`, role: 'assistant', content: 'Checking the code.', createdAt: at + i * 20_000 + 1000, toolCalls: [call] });
      messages.push({ id: `t${i}`, role: 'tool', content: '', createdAt: at + i * 20_000 + 2000, toolResult: { toolCallId: call.id, output: 'scroll scroll scroll' } });
    }
    messages.push({ id: `a${i}`, role: 'assistant', content: reply(i), createdAt: at + i * 20_000 + 5000 });
  }
  return { id: 'alpha', title: 'Search fixture chat', createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages, attachments: [], queuedPrompts: [] };
}

/** The expected whole-word, case-insensitive count of "scroll" in shown message text. */
function expectedScrollCount(): number {
  let n = 2; // the user question in turn 3
  for (let i = 0; i < TURNS; i++) {
    if (i % 5 === 0) n += i % 10 === 0 ? 2 : 1;
    if (i % 7 === 0) n += 1; // "the scroll guide" link text is shown; its URL is not
  }
  return n;
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

/** The highlights the search drew, as text, and which one is current. */
function highlights() {
  const reg = (CSS as any).highlights;
  const text = (name: string) => [...(reg?.get(name) ?? [])].map((r: Range) => r.toString());
  return { all: text('nekko-chat-search'), current: text('nekko-chat-search-current') };
}

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const reset = () => {
    clearLiveRun('alpha');
    record = makeSession();
    localStorage.clear();
    useStore.setState({ view: 'chat', providers: [provider], models, activeProviderId: 'fixture', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: 'alpha', activeProjectId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: {} }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false, paletteOpen: false } as any);
    putCachedSession(record);
    setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, highlights, expectedScrollCount, paletteOpen: () => (useStore.getState() as any).paletteOpen } });
  React.useEffect(() => reset(), []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <main style={{ flex: 1, minHeight: 0 }}><ChatPane sessionId="alpha" /></main>
  </div>;
}
// The fixture mounts ChatPane without App, so it installs the same global
// palette chord App.tsx does: the check is that Ctrl+F handling in the chat
// does not take Ctrl+K from the command palette.
window.addEventListener('keydown', (e) => {
  if (SHORTCUTS.palette.matches(e)) { e.preventDefault(); useStore.getState().setPaletteOpen(!useStore.getState().paletteOpen); }
});
createRoot(document.getElementById('root')!).render(<Fixture />);

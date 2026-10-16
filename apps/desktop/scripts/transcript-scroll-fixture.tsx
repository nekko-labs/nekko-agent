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
// A long chat whose rows render at sizes the estimate gets wrong (headings,
// lists, code blocks, tables, tool calls), so scrolling through it exercises
// the windowed transcript's measuring and scroll compensation.
const provider = { id: 'fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.now() - 3_600_000;

function reply(i: number): string {
  const parts = [`## Step ${i}: looking at the scroller\n`, `I read the file and found ${i % 7} places that matter. Here is what each one does and why it matters for the result.`];
  if (i % 2 === 0) parts.push('\n- first point about the layout\n- second point, a bit longer so it wraps onto another line in a narrow column\n- third point\n  - nested detail\n');
  if (i % 3 === 0) parts.push('\n```ts\nfunction example' + i + '(a: number, b: number) {\n  const sum = a + b;\n  if (sum > 10) return sum * 2;\n  return sum;\n}\nexport default example' + i + ';\n```\n');
  if (i % 5 === 0) parts.push('\n| Name | Value | Notes |\n| --- | --- | --- |\n| alpha | 1 | first |\n| beta | 2 | second |\n| gamma | 3 | third |\n');
  if (i % 4 === 1) parts.push('\n> A quoted note that spans a little more than one line so it wraps in the column and changes the height.\n');
  parts.push('\nThat is the summary for this step; the next one continues from here.');
  return parts.join('\n');
}

function makeSession(count: number) {
  const messages: any[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({ id: `u${i}`, role: 'user', content: i % 3 === 0 ? `Question ${i}: why does the list move when I scroll it? It seems to jump around a bit and I would like it to stay put.` : `Question ${i}`, createdAt: at + i * 20_000 });
    const calls = i % 2 === 0 ? [{ id: `c${i}a`, name: 'read_file', input: { path: `src/file${i}.ts` } }, { id: `c${i}b`, name: 'grep', input: { pattern: 'scrollTop' } }] : [];
    if (calls.length) {
      messages.push({ id: `a${i}x`, role: 'assistant', content: 'Let me check the code first.', createdAt: at + i * 20_000 + 1000, toolCalls: calls });
      calls.forEach((c, k) => messages.push({ id: `t${i}${k}`, role: 'tool', content: '', createdAt: at + i * 20_000 + 2000 + k, toolResult: { toolCallId: c.id, output: 'line 1\nline 2\nline 3' } }));
    }
    messages.push({ id: `a${i}`, role: 'assistant', content: reply(i), createdAt: at + i * 20_000 + 5000 });
  }
  return { id: 'alpha', title: 'Long scrolling chat', createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages, attachments: [], queuedPrompts: [] };
}

let record: any = makeSession(120);
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

// Every scroll position the scroller passes through, with a timestamp, and
// every animation frame's duration, for the sandbox to analyse.
const trace: { t: number; top: number; max: number; rows: Record<string, number> }[] = [];
const frames: number[] = [];
let tracing = false;
function startTrace() {
  trace.length = 0; frames.length = 0; tracing = true;
  const sc = document.querySelector<HTMLElement>('[data-transcript-scroll]')!;
  // Where the rows sit on screen: the top edge of every rendered row, by key,
  // relative to the scroller. Comparing two samples tells how far the content
  // the reader sees actually moved, whatever scrollTop did to get there.
  const rowTops = () => {
    const base = sc.getBoundingClientRect().top;
    const out: Record<string, number> = {};
    for (const el of sc.querySelectorAll<HTMLElement>('[data-vt-key]')) out[el.dataset.vtKey!] = el.getBoundingClientRect().top - base;
    return out;
  };
  const sample = () => trace.push({ t: performance.now(), top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, rows: rowTops() } as any);
  // Sampled once per frame, after it rendered (a message posted from rAF runs
  // after that frame's layout, ResizeObserver and paint). Reading layout in a
  // scroll handler or in rAF itself would catch the state before the
  // transcript's ResizeObserver corrects it, which is never painted.
  const after = new MessageChannel();
  after.port1.onmessage = () => { if (tracing) sample(); };
  let last = performance.now();
  const tick = (now: number) => { if (!tracing) return; frames.push(now - last); last = now; after.port2.postMessage(0); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  (window as any).__stopTrace = () => { tracing = false; return { trace: trace.slice(), frames: frames.slice() }; };
}

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const reset = (opts: { count?: number } = {}) => {
    clearLiveRun('alpha');
    record = makeSession(opts.count ?? 120);
    localStorage.clear();
    useStore.setState({ view: 'chat', providers: [provider], models, activeProviderId: 'fixture', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: 'alpha', activeProjectId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: {} }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    putCachedSession(record);
    setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, startTrace, stopTrace: () => (window as any).__stopTrace?.() } });
  React.useEffect(() => reset(), []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <main style={{ flex: 1, minHeight: 0 }}><ChatPane sessionId="alpha" /></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

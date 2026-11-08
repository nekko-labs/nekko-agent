// Real sidebar/store, synthetic host only. No provider, filesystem or GitHub calls.
const now = 1_800_000_000_000;
const pr = (n: number) => ({ url: `https://github.com/example/project/pull/${n}`, owner: 'example', repo: 'project', number: n, title: `Sidebar improvement ${n}`, state: 'merged', isDraft: false, additions: 3, deletions: 1, changedFiles: 1, checks: 'passing' });
const prs: Record<string, any[]> = {};
const sessions = Array.from({ length: 12 }, (_, i) => {
  const id = `done-${i}`;
  prs[id] = i === 0 ? [pr(100), pr(101), pr(102)] : [pr(100 + i * 3)];
  return { id, title: i === 0 ? 'Ship sidebar improvements' : `Completed implementation ${i + 1}`, providerId: 'fixture', modelId: 'gpt-fixture', createdAt: now - i * 1000, updatedAt: now - i * 1000, lastReplyAt: now - 3600000, messageCount: 2, exchangeCount: 1, transcriptTokens: 82000, recentTurns: [], prUrls: prs[id].map(p => p.url), imageCount: 0, stalled: false };
});
const working = { ...sessions[0], id: 'working', title: 'Implement next feature', transcriptTokens: 41000, prUrls: [] };
const watching = { ...sessions[0], id: 'watching', title: 'Watch required CI checks', activeWatchCount: 1, prUrls: [] };
const calls: string[] = [];
const opened: string[] = [];
const selected: string[] = [];
(window as any).nekkoChrome = { platform: 'win32', titleBarHeight: 38 };
(window as any).nekko = new Proxy({
  listSessionPrs: async (id: string) => { calls.push(id); await new Promise(r => setTimeout(r, 20)); return prs[id] ?? []; },
  engineStatus: async () => ({ running: false, resident: [] }),
  getGitStatus: async () => ({ repo: false }), runningSessions: async () => ['working'], pendingInput: async () => ({}),
  onAgentEvent: () => () => {}, openPath: async (url: string) => { opened.push(url); },
} as any, { get(t, k: string) { if (k in t) return t[k]; throw new Error(`Unexpected fixture API: ${k}`); } });
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/store'), import('../src/renderer/views/WorkspacesView')]).then(async ([React, { createRoot }, { useStore }, { AgentSidebar }]) => {
  await import('@fontsource-variable/inter-tight');
  await import('@fontsource-variable/jetbrains-mono');
  await import('../src/renderer/styles.css');
  localStorage.removeItem('nekko.agentPanelView');
  localStorage.setItem('nekko.wsSidebarWidth', '440');
  useStore.setState({ sessions: [working, watching, ...sessions], providers: [{ id: 'fixture', kind: 'chatgpt', label: 'ChatGPT', enabled: true }], models: [{ id: 'gpt-fixture', name: 'GPT fixture', providerId: 'fixture', contextLength: 272000 }], settings: { workspaces: [], showTips: false }, workspaces: [], terminals: [], prsBySession: {}, computers: [] } as any);
  createRoot(document.getElementById('root')!).render(React.createElement('main', { style: { height: '100vh', display: 'flex', background: 'var(--paper)', color: 'var(--ink)' } }, React.createElement('section', { style: { width: 440, maxWidth: '100%', height: '100%', display: 'flex', flexDirection: 'row' } }, React.createElement(AgentSidebar, { onOpenChat: (id: string) => selected.push(id), onOpenTerminal: () => {}, selectedId: 'done-0', onCreate: async () => {}, orientation: 'vertical' })), React.createElement('div', { style: { flex: 1, padding: 36, color: 'var(--ink-faint)' } }, 'Isolated sidebar verification')));
  (window as any).chipletFixture = { calls, opened, selected, store: useStore };
});

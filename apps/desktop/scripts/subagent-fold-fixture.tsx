// Real Agents panel with synthetic chats only; no host or user data. One chat has four
// sub-agents (so its list shows "Show more"), one has a single sub-agent, one has none.
window.addEventListener('error', event => console.error(event.error?.stack || event.message));
const noop = () => () => {};
(window as any).nekko = new Proxy({
  onAgentEvent: noop, runningSessions: async () => ['p2'], pendingInput: async () => ({}),
  getGitStatus: async (key: string) => ({ workspaceId: key, repo: true, branch: 'main', dirtyCount: 0, ahead: 0, behind: 0 }),
}, { get(target, key: string) { return key in target ? target[key as keyof typeof target] : key.startsWith('on') ? noop : async () => null; } });
localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy: 'status', showMetadata: true }));
localStorage.setItem('nekko.wsSidebarWidth', '380');
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/store'), import('../src/renderer/views/WorkspacesView')]).then(async ([React, { createRoot }, { useStore }, { AgentSidebar }]) => {
  await import('@fontsource-variable/geist');
  await import('@fontsource-variable/geist-mono');
  await import('../src/renderer/styles.css');
  const now = Date.now();
  let n = 0;
  const chat = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, createdAt: now - 1000 * ++n, updatedAt: now - 60_000 * n, lastReplyAt: now - 60_000 * n, mode: 'agent', chatType: 'multimodal', workspaceId: 'p1',
    providerId: 'local', modelId: 'qwen3-coder-30b', messageCount: 2, exchangeCount: 1, transcriptTokens: 4000, recentTurns: [], prUrls: [], imageCount: 0, stalled: false,
    ...extra,
  });
  const sessions = [
    chat('p1', 'Migrate the billing service', {}),
    chat('p2', 'Fix the login redirect', { phase: 'building' }),
    chat('p3', 'Tidy the icon sizes', {}),
    chat('k1', 'Check the responsive layout', { parentSessionId: 'p1' }),
    chat('k2', 'Run the unit tests', { parentSessionId: 'p1' }),
    chat('k3', 'Review the schema changes', { parentSessionId: 'p1' }),
    chat('k4', 'Update the changelog', { parentSessionId: 'p1' }),
    chat('k5', 'Audit the redirect URLs', { parentSessionId: 'p2' }),
  ];
  const settings = { workspaces: [{ id: 'p1', name: 'Acme app', paths: [] }], providers: [], showTips: false, agentActivityAnimation: false, theme: 'dark', themePreset: 'x-plum-dark' };
  useStore.setState({ sessions, workspaces: [], terminals: [], computers: [], settings, refreshSessions: async () => {}, refreshTerminals: async () => {}, refreshSessionPrs: async () => {} } as any);
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.dataset.preset = 'x-plum-dark';
  createRoot(document.getElementById('root')!).render(<main style={{ height: '100vh', display: 'flex', padding: 12, background: 'var(--paper)', color: 'var(--ink)' }}>
    <AgentSidebar selectedId={null} onOpenChat={() => {}} onOpenTerminal={() => {}} onCreate={async () => {}} />
  </main>);
});

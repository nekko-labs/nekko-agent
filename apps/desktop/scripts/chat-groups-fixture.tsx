// Real Agents panel with synthetic chats only; no host or user data. Seeds chat
// groups, empty buckets and saved custom colours (`?plain=1` seeds none, for the
// "before" shot). Theme comes from `?theme=light|dark`.
window.addEventListener('error', event => console.error(event.error?.stack || event.message));
const noop = () => () => {};
const query = new URLSearchParams(location.search);
const light = query.get('theme') === 'light';
const plain = query.has('plain');
const WORKING = ['b1', 'b2', 'b3', 'k2'];
(window as any).nekko = new Proxy({
  onAgentEvent: noop, runningSessions: async () => WORKING, pendingInput: async () => ({}),
  setSessionOptions: async (id: string, patch: object) => { (window as any).chatGroupsCalls.push({ id, patch }); return { id, ...patch }; },
}, { get(target, key: string) { return key in target ? target[key as keyof typeof target] : key.startsWith('on') ? noop : async () => null; } });
(window as any).chatGroupsCalls = [];
localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy: 'status', showMetadata: true }));
localStorage.setItem('nekko.wsSidebarWidth', '380');
if (!plain) {
  localStorage.setItem('nekko.chatGroups', JSON.stringify([{ name: 'Docs', color: 3 }, { name: 'Design review', color: '#b84fd6' }, { name: 'Frontend fixes', color: 3 }, { name: 'API', color: 1 }]));
  localStorage.setItem('nekko.chatGroupColors', JSON.stringify(['#b84fd6', '#2f9bbf', '#d4a017']));
} else {
  localStorage.removeItem('nekko.chatGroups');
  localStorage.removeItem('nekko.chatGroupColors');
}
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
  const g = (name: string) => (plain ? {} : { chatGroup: name });
  const sessions = [
    chat('b1', 'Fix the login redirect', { phase: 'building', ...g('Frontend fixes') }),
    chat('b2', 'Polish the settings page', { phase: 'building', ...g('Frontend fixes') }),
    chat('b3', 'Add a rate limiter', { phase: 'building', ...g('API') }),
    chat('w1', 'Watch CI on the cart change', { activeWatchCount: 1, ...g('API') }),
    chat('w2', 'Wait for the design sign-off', { activeWatchCount: 1 }),
    chat('d1', 'Update the button styles', { ...g('Frontend fixes') }),
    chat('d2', 'Tidy the icon sizes', { ...g('Frontend fixes') }),
    chat('d3', 'Fix the flaky cart test', { ...g('API') }),
    chat('d4', 'Rename the env vars'),
    chat('k1', 'Check the responsive layout', { parentSessionId: 'd1' }),
    chat('k2', 'Run the unit tests', { parentSessionId: 'd1' }),
    chat('a1', 'Old dark mode spike', { archivedAt: now - 86_400_000, ...g('Frontend fixes') }),
    chat('a2', 'Retire the v1 endpoints', { archivedAt: now - 2 * 86_400_000, ...g('API') }),
    chat('a3', 'Clean up the scratch branch', { archivedAt: now - 3 * 86_400_000 }),
    chat('a4', 'Try the new chart library', { archivedAt: now - 4 * 86_400_000, ...g('Frontend fixes') }),
  ];
  const settings = { workspaces: [{ id: 'p1', name: 'Acme app', paths: [] }], providers: [], showTips: false, agentActivityAnimation: false, theme: light ? 'light' : 'dark', themePreset: light ? 'x-plum-white' : 'x-plum-dark' };
  useStore.setState({ sessions, workspaces: [], terminals: [], computers: [], settings, refreshSessions: async () => {}, refreshTerminals: async () => {}, refreshSessionPrs: async () => {} } as any);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.documentElement.dataset.preset = light ? 'x-plum-white' : 'x-plum-dark';
  const root = createRoot(document.getElementById('root')!);
  root.render(<main style={{ height: '100vh', display: 'flex', padding: 12, background: 'var(--paper)', color: 'var(--ink)' }}>
    <AgentSidebar selectedId={null} onOpenChat={() => {}} onOpenTerminal={() => {}} onCreate={async () => {}} />
  </main>);
});

// Real Agents panel, chat header crumb and composer button with synthetic chats
// only; no host or user data. `?view=panel` (default) seeds groups, tags, empty
// buckets and saved custom colours (`?plain=1` seeds none, for the "before" shot);
// `?view=header` draws the chat title strip's crumb; `?view=composer` draws the
// new-chat button by the model picker. Theme comes from `?theme=light|dark`.
window.addEventListener('error', event => console.error(event.error?.stack || event.message));
const noop = () => () => {};
const query = new URLSearchParams(location.search);
const light = query.get('theme') === 'light';
const plain = query.has('plain');
const view = query.get('view') ?? 'panel';
const WORKING = ['b1', 'b2', 'b3', 'k2'];
const NO_GIT = new Set(['d4', 'w2']);
(window as any).nekko = new Proxy({
  onAgentEvent: noop, runningSessions: async () => WORKING, pendingInput: async () => ({}),
  setSessionOptions: async (id: string, patch: object) => { (window as any).chatGroupsCalls.push({ id, patch }); return { id, ...patch }; },
  getGitStatus: async (key: string) => {
    const id = key.replace('session:', '');
    return NO_GIT.has(id) ? { workspaceId: key, repo: false, dirtyCount: 0, ahead: 0, behind: 0 } : { workspaceId: key, repo: true, branch: BRANCH[id] ?? 'main', dirtyCount: 0, ahead: 0, behind: 0 };
  },
}, { get(target, key: string) { return key in target ? target[key as keyof typeof target] : key.startsWith('on') ? noop : async () => null; } });
const BRANCH: Record<string, string> = { b1: 'fix/login-redirect', b2: 'settings-polish', b3: 'api/rate-limit', w1: 'cart-ci', d1: 'buttons', d2: 'icons', d3: 'fix/flaky-cart-test' };
(window as any).chatGroupsCalls = [];
localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy: 'status', showMetadata: true }));
localStorage.setItem('nekko.wsSidebarWidth', '380');
// Group ids, so a chat stores the id and a rename changes nothing else.
const FRONT = 'g_frontend01', API = 'g_apiteam001', DOCS = 'g_docsgroup1', REVIEW = 'g_review0001', DOT = 'g_unnamed001', RELEASE = 'g_release001';
if (!plain) {
  localStorage.setItem('nekko.chatGroups', JSON.stringify([
    { id: DOCS, name: 'Docs', color: 0 }, { id: REVIEW, name: 'Design review', color: '#b84fd6' }, { id: FRONT, name: 'Frontend fixes', color: 3 },
    { id: API, name: 'API', color: 1 }, { id: DOT, color: 4 }, ...(view === 'composer' ? [{ id: RELEASE, name: 'Release prep', color: 5 }] : []),
  ]));
  localStorage.setItem('nekko.chatGroupColors', JSON.stringify(['#b84fd6', '#2f9bbf', '#d4a017']));
  localStorage.setItem('nekko.chatTags', JSON.stringify(['frontend', 'urgent', 'ui', 'release']));
} else {
  localStorage.removeItem('nekko.chatGroups');
  localStorage.removeItem('nekko.chatGroupColors');
  localStorage.removeItem('nekko.chatTags');
}
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/store'), import('../src/renderer/views/WorkspacesView'), import('../src/renderer/components/ChatBreadcrumb'), import('../src/renderer/components/ChatGroupTagControls')]).then(async ([React, { createRoot }, { useStore }, { AgentSidebar }, { ChatBreadcrumb }, { ChatGroupTagButton }]) => {
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
  const g = (id: string) => (plain ? {} : { chatGroup: id });
  const t = (...tags: string[]) => (plain ? {} : { tags });
  const sessions = [
    chat('b1', 'Fix the login redirect', { phase: 'building', ...g(FRONT), ...t('frontend', 'urgent') }),
    chat('b2', 'Polish the settings page', { phase: 'building', ...g(FRONT), ...t('ui', 'frontend', 'urgent', 'release', 'a11y') }),
    chat('b3', 'Add a rate limiter', { phase: 'building', ...g(API), ...t('backend') }),
    chat('w1', 'Watch CI on the cart change', { activeWatchCount: 1, ...g(API) }),
    chat('w2', 'Wait for the design sign-off', { activeWatchCount: 1, ...g(DOT), ...t('review') }),
    chat('d1', 'Update the button styles', { ...g(FRONT), ...t('ui') }),
    chat('d2', 'Tidy the icon sizes', { ...g(FRONT) }),
    chat('d3', 'Fix the flaky cart test', { ...g(API), ...t('tests', 'flaky') }),
    chat('d4', 'Rename the env vars', plain ? {} : { chatGroup: DOT }),
    chat('k1', 'Check the responsive layout', { parentSessionId: 'd1' }),
    chat('k2', 'Run the unit tests', { parentSessionId: 'd1' }),
    chat('a1', 'Old dark mode spike', { archivedAt: now - 86_400_000, ...g(FRONT) }),
    chat('a2', 'Retire the v1 endpoints', { archivedAt: now - 2 * 86_400_000, ...g(API) }),
    chat('a3', 'Clean up the scratch branch', { archivedAt: now - 3 * 86_400_000 }),
    chat('a4', 'Try the new chart library', { archivedAt: now - 4 * 86_400_000, ...g(FRONT) }),
    // The header and composer views.
    chat('h1', 'Fix the login redirect', { ...g(FRONT), ...t('frontend', 'urgent') }),
    chat('h2', 'Wait for the design sign-off', { ...g(DOT), ...t('review') }),
  ];
  const settings = { workspaces: [{ id: 'p1', name: 'Acme app', paths: [] }], providers: [], showTips: false, agentActivityAnimation: false, theme: light ? 'light' : 'dark', themePreset: light ? 'x-plum-white' : 'x-plum-dark' };
  useStore.setState({ sessions: view === 'panel' ? sessions.filter(s => !/^h\d/.test(s.id)) : sessions, workspaces: [], terminals: [], computers: [], settings, refreshSessions: async () => {}, refreshTerminals: async () => {}, refreshSessionPrs: async () => {} } as any);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.documentElement.dataset.preset = light ? 'x-plum-white' : 'x-plum-dark';
  const root = createRoot(document.getElementById('root')!);
  const strip = (id: string, title: string) => (
    <div data-crumb-strip={id} className="flex items-center gap-1.5 rounded-lg px-3 py-2" style={{ background: 'var(--surface)', border: '1px solid var(--line)', width: 560 }}>
      <ChatBreadcrumb sessionId={id} titleNode={<span className="min-w-0 max-w-[35%] truncate text-xs" style={{ fontWeight: 500 }}>{title}</span>} />
    </div>
  );
  if (view === 'header') {
    root.render(<main style={{ padding: 24, background: 'var(--paper)', color: 'var(--ink)', display: 'flex', flexDirection: 'column', gap: 16 }} data-agent-group="header">
      {strip('h1', 'Fix the login redirect')}{strip('h2', 'Wait for the design sign-off')}
    </main>);
  } else if (view === 'composer') {
    root.render(<main style={{ padding: 24, background: 'var(--paper)', color: 'var(--ink)', minHeight: '100vh' }} data-agent-group="composer">
      <div data-composer-bar className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ background: 'var(--surface)', border: '1px solid var(--line)', width: 420 }}>
        <span className="text-2xs text-ink-soft">qwen3-coder-30b</span>
        <ChatGroupTagButton sessionId="new-chat" />
      </div>
    </main>);
  } else {
    root.render(<main style={{ height: '100vh', display: 'flex', padding: 12, background: 'var(--paper)', color: 'var(--ink)' }}>
      <AgentSidebar selectedId={null} onOpenChat={() => {}} onOpenTerminal={() => {}} onCreate={async () => {}} />
    </main>);
  }
});

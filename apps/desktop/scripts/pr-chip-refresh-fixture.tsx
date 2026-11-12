// Real PR chips (a reply's PrLinkChip and the agent card's chip), synthetic host
// only: no provider, filesystem or GitHub calls. `prRefreshFixture.merge()`
// flips the stub GitHub's PRs from open to merged, as if they merged on GitHub
// while the chat stayed on screen.
const now = 1_800_000_000_000;
const urls = [2628, 2629].map((n) => `https://github.com/example/project/pull/${n}`);
const state: Record<string, 'open' | 'merged'> = Object.fromEntries(urls.map((u) => [u, 'open']));
const info = (url: string) => {
  const number = Number(url.split('/').pop());
  return { url, owner: 'example', repo: 'project', number, title: `Fixture change ${number}`, state: state[url], isDraft: false, additions: 3, deletions: 1, changedFiles: 1, checks: 'passing', source: 'gh' };
};
const reads = { pr: 0, session: 0 };
const session = { id: 'done-0', title: 'Land three fixes', providerId: 'fixture', modelId: 'gpt-fixture', createdAt: now, updatedAt: now, lastReplyAt: now - 3600000, messageCount: 2, exchangeCount: 1, transcriptTokens: 82000, recentTurns: [], prUrls: urls, imageCount: 0, stalled: false };
(window as any).nekkoChrome = { platform: 'win32', titleBarHeight: 38 };
(window as any).nekko = new Proxy({
  getPrInfo: async (url: string) => { reads.pr++; return info(url); },
  listSessionPrs: async () => { reads.session++; return urls.map(info); },
  engineStatus: async () => ({ running: false, resident: [] }),
  getGitStatus: async () => ({ repo: false }), runningSessions: async () => [], pendingInput: async () => ({}),
  onAgentEvent: () => () => {}, openPath: async () => {},
} as any, { get(t, k: string) { if (k in t) return t[k]; throw new Error(`Unexpected fixture API: ${k}`); } });
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/store'), import('../src/renderer/views/WorkspacesView'), import('../src/renderer/components/PrLinkChip')]).then(async ([React, { createRoot }, { useStore }, { AgentSidebar }, { PrLinkChip }]) => {
  await import('@fontsource-variable/geist');
  await import('@fontsource-variable/geist-mono');
  await import('../src/renderer/styles.css');
  localStorage.removeItem('nekko.agentPanelView');
  localStorage.setItem('nekko.wsSidebarWidth', '440');
  useStore.setState({ sessions: [session], providers: [{ id: 'fixture', kind: 'chatgpt', label: 'ChatGPT', enabled: true }], models: [{ id: 'gpt-fixture', name: 'GPT fixture', providerId: 'fixture', contextLength: 272000 }], settings: { workspaces: [], showTips: false }, workspaces: [], terminals: [], prsBySession: {}, computers: [] } as any);
  const e = React.createElement;
  const reply = e('div', { style: { flex: 1, padding: 36, maxWidth: 640 }, className: 'text-ink' },
    e('p', { className: 'text-sm leading-6' }, 'Both PRs are open and will merge once CI passes: ', e(PrLinkChip, { href: urls[0], label: '#2628' }), ' and ', e(PrLinkChip, { href: urls[1], label: '#2629' }), '.'));
  createRoot(document.getElementById('root')!).render(e('main', { style: { height: '100vh', display: 'flex', background: 'var(--paper)', color: 'var(--ink)' } },
    e('section', { style: { width: 440, maxWidth: '100%', height: '100%', display: 'flex', flexDirection: 'row' } },
      e(AgentSidebar, { onOpenChat: () => {}, onOpenTerminal: () => {}, selectedId: 'done-0', onCreate: async () => {}, orientation: 'vertical' })),
    reply));
  (window as any).prRefreshFixture = { reads, merge: () => { for (const u of urls) state[u] = 'merged'; } };
});

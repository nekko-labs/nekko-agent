// Real Agents panel with synthetic summaries only; no host or user data.
window.addEventListener('error', event => console.error(event.error?.stack || event.message));
const noop = () => () => {};
let fullSessionReads = 0;
(window as any).nekko = new Proxy({
  onAgentEvent: noop, runningSessions: async () => [], pendingInput: async () => ({}),
  getSession: async () => { fullSessionReads++; return null; },
}, { get(target, key: string) { return key in target ? target[key as keyof typeof target] : key.startsWith('on') ? noop : async () => null; } });
localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy: 'project', showMetadata: false }));
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/store'), import('../src/renderer/views/WorkspacesView')]).then(async ([React, { createRoot }, { useStore }, { AgentSidebar }]) => {
  await import('@fontsource-variable/inter-tight');
  await import('@fontsource-variable/jetbrains-mono');
  await import('../src/renderer/styles.css');
  const sessions = ['alpha', 'beta', 'completed'].flatMap((group) => Array.from({ length: 65 }, (_, i) => ({
    id: `${group}-${i}`, title: `${group === 'completed' ? 'Completed' : group === 'alpha' ? 'Alpha' : 'Beta'} task ${String(i + 1).padStart(2, '0')}`,
    createdAt: 1700000000000 - i, updatedAt: 1700000000000 - i, mode: 'agent', chatType: 'multimodal',
    workspaceId: group === 'beta' ? 'beta' : 'alpha', messageCount: 2,
    prUrls: i === 64 && group !== 'completed' ? ['https://github.com/example/fixture/pull/1'] : [],
    ...(group === 'completed' ? { archivedAt: 1700000000000 - i } : {}),
  })));
  const settings = { workspaces: [{ id: 'alpha', name: 'Alpha project', paths: [] }, { id: 'beta', name: 'Beta project', paths: [] }], providers: [], showTips: false, agentActivityAnimation: false, theme: 'dark', themePreset: 'x-plum-dark' };
  const prReads: string[] = [];
  useStore.setState({ sessions, workspaces: [], terminals: [], computers: [], settings, refreshSessions: async () => {}, refreshTerminals: async () => {}, refreshSessionPrs: async (id: string) => {
    prReads.push(id);
    useStore.setState({ prsBySession: { ...useStore.getState().prsBySession, [id]: [] } });
  } } as any);
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.dataset.preset = 'x-plum-dark';
  let select: (id: string | null) => void;
  function Fixture() {
    const [selected, setSelected] = React.useState<string | null>(null);
    const [orientation, setOrientation] = React.useState<'vertical' | 'horizontal'>('vertical');
    select = setSelected;
    return <main style={{ height: '100vh', display: 'flex', padding: 12, background: 'var(--paper)', color: 'var(--ink)' }}>
      <AgentSidebar selectedId={selected} onOpenChat={setSelected} onOpenTerminal={setSelected} onCreate={async () => {}} orientation={orientation} onOrientation={setOrientation} />
      <div style={{ padding: 24 }}><h1>Agent groups</h1><p>65 agents per project. Completed chats stay folded until opened.</p></div>
    </main>;
  }
  const root = createRoot(document.getElementById('root')!);
  root.render(<Fixture />);
  (window as any).groupLimitFixture = { select: (id: string | null) => select(id), reads: () => fullSessionReads, prReads, store: useStore, group: (groupBy: string) => {
    localStorage.setItem('nekko.agentPanelView', JSON.stringify({ groupBy, showMetadata: false }));
    root.render(<Fixture key={groupBy} />);
  } };
});

// The model picker for a Claude Agent account on a given plan (`?plan=pro`, `?plan=max`).
// Real renderer controls with a synthetic bridge. No host, credentials or network.
const plan = new URLSearchParams(location.search).get('plan') || 'pro';
const providers = [{ id: 'claude', kind: 'claude-code', label: 'Claude Agent', baseUrl: '', enabled: true }];
const models = [
  ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-fable-5-2', 'Claude Fable 5.2'], ['claude-fable-5-1', 'Claude Fable 5.1'], ['claude-haiku-5-5', 'Claude Haiku 5.5'],
].map(([id, name]) => ({ id, name, providerId: 'claude' }));
const bridge: any = {
  listModels: async () => models,
  getLimits: async () => null,
  getClaudeCodeStatus: async () => ({ installed: true, version: '2.1.322', loggedIn: true, authMethod: 'claude.ai', auth: 'subscription', email: 'person@example.test', orgName: 'Personal', subscriptionType: plan }),
  updateSettings: async () => ({}), getSettings: async () => ({}),
};
Object.assign(window, { nekko: new Proxy(bridge, { get: (t, k: string) => k in t ? t[k] : k.startsWith('on') ? () => () => {} : () => Promise.resolve(null) }) });
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/agent-console/ModelPicker'), import('../src/renderer/store'), import('@fontsource-variable/geist'), import('../src/renderer/styles.css')]).then(([React, { createRoot }, { ModelPicker }, { useStore }]) => {
  useStore.setState({ providers, settings: { favoriteModels: [] }, sessions: [] } as any);
  function Fixture() {
    const [open, setOpen] = React.useState(true);
    return <main style={{ height: '100vh', padding: 24, background: 'var(--paper)', color: 'var(--ink)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div className="card p-3"><p className="mb-3 text-xs text-ink-faint">Message Nekko…</p>
        <ModelPicker providers={providers as any} providerId="claude" modelId="claude-opus-5-5" models={models} open={open} onOpenChange={setOpen} onProvider={() => {}} onModel={() => {}} />
      </div>
    </main>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture />);
});

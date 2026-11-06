// Real renderer controls with synthetic accounts. No host, credentials or network.
const now = Date.now();
const providers = [
  { id: 'gpt', kind: 'chatgpt', label: 'ChatGPT', baseUrl: '', enabled: true, auth: 'subscription', tokenKey: 'chatgpt:fixture' },
  { id: 'claude', kind: 'claude-code', label: 'Claude Agent', baseUrl: '', enabled: true },
  { id: 'local', kind: 'ollama', label: 'Local models', baseUrl: '', enabled: true },
];
const models = [
  ...['GPT 6', 'GPT 6 Mini', 'GPT 6 Pro'].map((name, i) => ({ id: `gpt-${i}`, name, providerId: 'gpt' })),
  ...['Opus', 'Sonnet', 'Haiku'].map(name => ({ id: name.toLowerCase(), name, providerId: 'claude' })),
  ...['Qwen 3 8B', 'Gemma 4', 'Llama 4'].map((name, i) => ({ id: `local-${i}`, name, providerId: 'local' })),
];
const limits = (percent: number) => ({ updatedAt: now, staleAfterMs: 300000, windows: [
  { id: 'session', label: '5 hours', scope: 'session', usedPercent: percent, resetAt: now + 7200000, status: percent >= 80 ? 'warning' : 'allowed' },
  { id: 'weekly', label: 'Weekly', scope: 'weekly', usedPercent: 28, resetAt: now + 86400000, status: 'allowed' },
] });
const listeners = new Set<(e: unknown) => void>();
const bridge: any = {
  listModels: async (id: string) => models.filter(m => m.providerId === id),
  getLimits: async (key: string) => limits(key.startsWith('chatgpt') ? 62 : 85),
  onLimitsUpdated: (cb: (e: unknown) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
  getSubscriptionStatus: async () => null,
  setSessionOptions: async (_id: string, patch: unknown) => ({ id: 'fixture', mode: 'yolo', ...patch as object }),
  updateSettings: async () => ({}), getSettings: async () => ({}),
};
Object.assign(window, { nekko: new Proxy(bridge, { get: (t, k: string) => k in t ? t[k] : k.startsWith('on') ? () => () => {} : () => Promise.resolve(null) }) });
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/agent-console/ModelPicker'), import('../src/renderer/components/AsksFirstMenu'), import('../src/renderer/store'), import('@fontsource-variable/inter-tight'), import('../src/renderer/styles.css')]).then(([React, { createRoot }, { ModelPicker }, { AsksFirstMenu }, { useStore }]) => {
  useStore.setState({ providers, settings: { favoriteModels: [] }, sessions: [] } as any);
  function Fixture() {
    const [open, setOpen] = React.useState(true);
    const [selection, setSelection] = React.useState({ providerId: 'gpt', modelId: 'gpt-0' });
    const [session, setSession] = React.useState<any>({ id: 'fixture', mode: 'yolo' });
    return <main style={{ height: '100vh', padding: 24, background: 'var(--paper)', color: 'var(--ink)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div className="card p-3"><p className="mb-3 text-xs text-ink-faint">Message Nekko…</p><div className="flex flex-wrap items-center gap-3">
        <ModelPicker providers={providers as any} {...selection} models={models.filter(m => m.providerId === selection.providerId)} open={open} onOpenChange={setOpen} onProvider={() => {}} onModel={(providerId, modelId) => { setSelection({ providerId, modelId }); (window as any).pickerFixture.picked = modelId; }} />
        <AsksFirstMenu session={session} onChange={s => s && setSession(s)} />
      </div></div>
    </main>;
  }
  (window as any).pickerFixture = { listeners, limits, emit: () => listeners.forEach(cb => cb({ tokenKey: 'chatgpt:fixture', limits: limits(93) })) };
  createRoot(document.getElementById('root')!).render(<Fixture />);
});

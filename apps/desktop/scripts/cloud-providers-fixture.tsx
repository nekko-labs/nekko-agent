// Real provider forms with a synthetic bridge. Never reads a user profile or calls a provider.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles.css';
const calls: unknown[] = [];
(window as any).nekko = new Proxy({
  testProviderConfig: async (p: unknown) => { calls.push({ test: p }); return (window as any).providerFixture.failure ? { ok: false, message: 'Fixture: credentials rejected' } : { ok: true, message: 'Connected' }; },
  saveProvider: async (p: unknown) => { calls.push({ save: p }); },
  getClaudeCodeStatus: async () => ({ installed: false }),
  listProviders: async () => [],
  getSettings: async () => ({ providers: [] }),
}, { get(t, k: string) { if (k in t) return (t as any)[k]; return k.startsWith('on') ? () => () => {} : async () => null; } });
Promise.all([import('../src/renderer/components/providers/AddProvider'), import('../src/renderer/components/providers/ProviderChoices'), import('../src/renderer/views/ModelsView')]).then(([{ AddProvider }, { ProviderChoices }, { ProviderShortcuts }]) => {
  const root = createRoot(document.getElementById('root')!);
  (window as any).providerFixture = { calls, show: (mode: string) => {
    const before = location.pathname.includes('before-cloud');
    const kind = mode === 'google' ? (before ? 'vertex' : 'gemini') : mode === 'ollama' ? (before ? 'ollama' : 'ollama-cloud') : mode;
    // A setup renders the way the Models page shows it: the add strip, then the open setup.
    const setup = (k: string) => <section className="models-providers">
      <div className="models-provider-bar"><ProviderShortcuts {...{ open: k } as any} onAdd={(choice) => calls.push({ choice })} /></div>
      <div className="provider-setup"><button type="button" className="provider-setup-close" aria-label="Close provider setup">×</button><AddProvider key={k} fixedKind={k as any} onDone={() => calls.push({ done: true })} /></div>
    </section>;
    root.render(<main style={{ padding: 20, color: 'var(--ink)', background: 'var(--paper)', minHeight: '100vh' }}>
      <h2 className="models-section-heading">Cloud providers</h2>
      {mode === 'chooser' ? <ProviderChoices {...{ scope: 'cloud' } as any} onPick={(choice) => calls.push({ choice })} /> : mode === 'shortcuts' ? <ProviderShortcuts onAdd={(choice) => calls.push({ choice })} /> : setup(kind)}
    </main>);
  } };
});

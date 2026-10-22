import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { AddProvider } from '../apps/desktop/src/renderer/components/providers/AddProvider';
import '../apps/desktop/src/renderer/styles.css';

// No backend: every bridge call resolves empty, nothing leaves the window.
Object.assign(window, {
  nekko: new Proxy({}, { get: (_t, k: string) => (k.startsWith('on') ? () => () => {} : () => Promise.resolve(null)) }),
});
try { localStorage.clear(); } catch {}
useStore.setState({ providers: [], models: [], pushToast: () => {} } as any);

// Model Providers > Add provider with Anthropic picked, as ModelsView frames it.
function Fixture() {
  return (
    <main data-evidence-route="add-anthropic" className="bg-paper" style={{ minHeight: '100vh', padding: 24 }}>
      <h1 className="text-[20px] font-semibold">Model Providers</h1>
      <AddProvider initialKind="anthropic" onDone={() => {}} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

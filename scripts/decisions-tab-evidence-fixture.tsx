import React from 'react';
import { createRoot } from 'react-dom/client';
import { DecisionModels } from '../apps/desktop/src/renderer/components/engine/DecisionModels';
import { useStore } from '../apps/desktop/src/renderer/store';
import '../apps/desktop/src/renderer/styles.css';

// The renderer asks the engine for its catalog, models and status; the catalog is whatever the
// revision's host serves, injected by the evidence script as window.__catalog.
const w = window as unknown as { __catalog: unknown[]; __installed: unknown[]; nekko: unknown };
w.nekko = new Proxy({}, {
  get: (_, k: string) => {
    if (k === 'decisionsCatalog') return () => Promise.resolve(w.__catalog);
    if (k === 'decisionsModels') return () => Promise.resolve(w.__installed);
    if (k === 'decisionsStatus') return () => Promise.resolve({ local: { available: true, loaded: true, model: 'laya-en', ep: 'directml', precision: 'fp16', loadMs: 2218 }, typesafe: { configured: false } });
    return k.startsWith('on') ? () => () => {} : () => Promise.resolve(null);
  },
});
useStore.setState({ settings: {} as never });
createRoot(document.getElementById('root')!).render(
  <main className="bg-paper text-ink" style={{ width: '100vw', minHeight: '100vh', padding: 24, boxSizing: 'border-box' }}>
    <div style={{ maxWidth: 860 }}><DecisionModels /></div>
  </main>,
);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { ConnectorGrid } from '../apps/desktop/src/renderer/components/ConnectorGrid';
import '../apps/desktop/src/renderer/styles.css';

// No backend: nothing is connected and every other bridge call resolves empty.
Object.assign(window, {
  nekko: new Proxy({}, {
    get: (_t, k: string) => (k.startsWith('on') ? () => () => {} : k === 'listConnectors' ? () => Promise.resolve([]) : () => Promise.resolve(null)),
  }),
});
try { localStorage.clear(); } catch {}
useStore.setState({ pushToast: () => {} } as any);

// The Connectors view's grid, as ConnectorsView frames it.
function Fixture() {
  return (
    <main data-evidence-route="connectors" className="bg-paper" style={{ minHeight: '100vh', padding: 24 }}>
      <h1 className="text-[20px] font-semibold" style={{ marginBottom: 16 }}>Connectors</h1>
      <ConnectorGrid />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

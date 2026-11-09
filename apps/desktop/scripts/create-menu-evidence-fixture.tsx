// Tiny standalone fixture: only mounts the Create plus-menu's rows for before/after comparison.
// Dark theme forced; no App, no bridge needed — CreateMenuRows is pure.
import * as React from 'react';
import { createRoot } from 'react-dom/client';

async function main() {
  const { CreateMenuRows } = await import('../src/renderer/components/CreateMenu');
  await import('@fontsource-variable/geist');
  await import('../src/renderer/styles.css');
  document.documentElement.dataset.theme = 'dark';
  const root = createRoot(document.getElementById('root')!);
  // Passing `terminal: false` on the base (where the prop exists) hides Terminal to mirror Simple mode;
  // on this branch the prop is gone and all three rows always show.
  root.render(
    React.createElement('div', { style: { padding: 32, background: 'var(--paper)', minHeight: '100vh', color: 'var(--ink)' } },
      React.createElement('div', { className: 'create-menu card p-1 shadow-(--shadow-float)', style: { width: 'max-content' } },
        React.createElement(CreateMenuRows as any, { onCreate: () => {}, terminal: false })))
  );
  (window as any).layoutFixture = { ready: true };
}
void main();

// Isolated real icon lifecycle/motion fixture; no bridge, daemon or network.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { GfIcon, type GfIconName } from '../src/renderer/gentleface-icons.js';
import '../src/renderer/styles.css';

const names: GfIconName[] = ['sidebar-collapse', 'sidebar-expand', 'info', 'check-circle', 'log-out', 'send', 'stop', 'folder-open', 'terminal', 'workflow', 'server', 'gauge', 'focus', 'lock', 'router', 'brain-circuit', 'shield-question'];
const calls: { method: string; connected: boolean; time?: number }[] = [];
for (const method of ['pauseAnimations', 'unpauseAnimations', 'setCurrentTime'] as const) {
  const original = SVGSVGElement.prototype[method];
  SVGSVGElement.prototype[method] = function (time?: number) {
    calls.push({ method, connected: this.isConnected, time });
    return original.call(this, time!);
  };
}
const root = createRoot(document.getElementById('root')!);
const render = (alternate = false) => flushSync(() => root.render(<main style={{ padding: 32, color: 'var(--ink)', background: 'var(--paper)', height: '100%' }}>
  <h1 style={{ fontSize: 22, marginBottom: 24 }}>Synthetic icon lifecycle / motion</h1>
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 18 }}>
    {names.map((name, i) => <button key={name} id={'icon-' + i} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 90, padding: 12, border: '1px solid var(--line)', borderRadius: 12 }}>
      <GfIcon name={alternate && i === 0 ? 'send' : name} className="h-10 w-10" /><span>{name}</span>
    </button>)}
  </div>
</main>));
(window as any).icons = { calls, render, clear: () => { calls.length = 0; }, unmount: () => flushSync(() => root.render(null)), states: () => [...document.querySelectorAll<SVGSVGElement>('.gf-icon-motion')].map(svg => ({ name: svg.closest('[data-gf-icon]')?.getAttribute('data-gf-icon'), paused: svg.animationsPaused(), time: svg.getCurrentTime() })) };
render();

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { TerminalPane } from '../src/renderer/components/TerminalPane';
import '../src/renderer/styles.css';

// Synthetic only: a fake shell stream that echoes input. No pty, host or daemon.
const writes: string[] = [];
const enc = new TextEncoder();
let emit: ((bytes: Uint8Array) => void) | null = null;
const say = (s: string) => emit?.(enc.encode(s));
const bridge: any = {
  openTerminalStream: async (id: string, h: any) => {
    emit = h.onData;
    setTimeout(() => {
      h.onHello({ info: { id, title: 'Synthetic', cwd: 'C:\\synthetic\\repo', shell: 'synthetic', createdAt: 1, running: true } });
      say('PS C:\\synthetic\\repo> npm test\r\nall 42 tests passed\r\nPS C:\\synthetic\\repo> ');
    }, 50);
    return {
      write: (d: string) => { writes.push(d); say(d === '\x03' ? '^C\r\nPS C:\\synthetic\\repo> ' : d); },
      resize() {}, ack() {}, close() {},
    };
  },
  terminalSnapshot: async () => ({ info: { id: 'agent_log', title: 'Agent commands', cwd: '/', shell: 'agent', agentSessionId: 's', createdAt: 1, running: false }, buffer: '$ git status\r\nclean\r\n', cols: 80, rows: 24 }),
  openPath: async () => {}, resizeTerminal() {}, writeTerminal() {},
};
// In-memory clipboard, so verification never reads or replaces the user's.
const clip = { text: 'pasted-from-clipboard', fail: false };
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (t: string) => { if (clip.fail) throw Error('denied'); clip.text = t; },
  readText: async () => { if (clip.fail) throw Error('denied'); return clip.text; },
} });
Object.assign(window, { clip });
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

/** Fixture-only readout of the in-memory clipboard, so captures can show what Copy did. */
function ClipboardReadout() {
  const [text, setText] = useState(clip.text);
  React.useEffect(() => { const t = setInterval(() => setText(clip.text), 50); return () => clearInterval(t); }, []);
  return (
    <div data-clipboard-readout style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 12px', borderTop: '1px solid var(--line, #ddd)', font: '12px system-ui, sans-serif', background: 'var(--paper)', color: 'var(--ink)' }}>
      <span style={{ opacity: 0.6 }}>Clipboard (test fixture):</span>
      <code style={{ fontFamily: 'Consolas, monospace', padding: '1px 6px', borderRadius: 4, background: 'var(--surface-2)' }}>{JSON.stringify(text)}</code>
    </div>
  );
}

function Fixture() {
  const [id, setId] = useState('term-1');
  const [readout, setReadout] = useState(false);
  Object.assign(window, { integration: { writes, toasts: () => useStore.getState().toasts, show: setId, readout: setReadout } });
  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}><TerminalPane key={id} terminalId={id} /></div>
      {readout && <ClipboardReadout />}
    </main>
  );
}
useStore.setState({ settings: { terminal: { renderer: 'xterm' } } } as any);
createRoot(document.getElementById('root')!).render(<Fixture />);

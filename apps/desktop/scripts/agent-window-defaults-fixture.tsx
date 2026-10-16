import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { AgentWindowPicker } from '../src/renderer/components/AgentWindowPicker';
import { ChatControls } from '../src/renderer/components/ChatControls';
import '../src/renderer/styles.css';

// No host, credentials, filesystem, provider client or transport is loaded.
const copy = (value: any) => JSON.parse(JSON.stringify(value));
const providers = [{ id: 'synthetic', kind: 'ollama', label: 'Synthetic memory only', enabled: true }];
const models = ['alpha', 'beta'].map(id => ({ id: `fixture-${id}`, name: `Fixture ${id}`, providerId: 'synthetic' }));
let settings: any;
let record: any;
let serial = 0;
const calls: any[] = [];
const construct = () => ({ id: `fixture-${++serial}`, title: 'Synthetic new session', messages: [], createdAt: 1, updatedAt: 1, executionMode: settings.defaultExecutionMode, gitIsolation: settings.gitManagement.mode !== 'shared' });
const bridge = {
  getSettings: async () => copy(settings),
  updateSettings: async (patch: any) => { calls.push({ api: 'updateSettings', patch: copy(patch) }); Object.assign(settings, copy(patch)); return copy(settings); },
  listModels: async (id: string) => { calls.push({ api: 'listModels', id }); return copy(models); },
  setSessionOptions: async (id: string, patch: any) => { if (record.id !== id) throw Error('Unknown synthetic session'); calls.push({ api: 'setSessionOptions', id, patch: copy(patch) }); Object.assign(record, copy(patch)); return copy(record); },
  listTools: async () => [],
  listSessionSummaries: async () => [copy(record)],
  getSession: async () => copy(record),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key) { if (!(key in target)) throw Error(`Unexpected synthetic API: ${String(key)}`); return target[key as keyof typeof target]; } }) });

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const [open, setOpen] = useState(true);
  const [session, setSession] = useState<any>(null);
  const reset = () => {
    settings = { theme: 'light', workspaces: [], mcpServers: [], favoriteModels: [], defaultProviderId: 'synthetic', defaultModelId: 'fixture-alpha', defaultChatMode: 'guardrails', defaultExecutionMode: 'worktree', gitManagement: { mode: 'worktree' }, effort: 'normal' };
    calls.length = 0; record = construct(); localStorage.clear();
    useStore.setState({ settings: copy(settings), providers, models, activeProviderId: 'synthetic', activeModelId: 'fixture-alpha', sessions: [], terminals: [], toasts: [] } as any);
    setSession(copy(record)); setEpoch(e => e + 1); setOpen(true);
  };
  Object.assign(window, { integration: {
    reset, calls, settings: () => copy(settings), record: () => copy(record), state: () => useStore.getState(),
    remount: () => { setEpoch(e => e + 1); setOpen(true); },
    newSession: () => { record = construct(); setSession(copy(record)); setEpoch(e => e + 1); },
    theme: (theme: string) => { settings.theme = theme; useStore.setState({ settings: copy(settings) }); document.documentElement.dataset.theme = theme; },
  } });
  React.useEffect(reset, []);
  return <main style={{ height: '100vh', padding: 12, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--surface)', color: 'var(--ink)' }}>
    <header style={{ fontSize: 12 }}>Isolated synthetic defaults fixture</header>
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><div style={{ maxWidth: 640, margin: '0 auto' }}>{open && <AgentWindowPicker key={epoch} onClose={() => setOpen(false)} onAdd={async selection => { calls.push({ api: 'onAdd', selection }); setOpen(false); }} />}</div></div>
    <section className="card p-3" aria-label="New session controls"><p className="mb-2 text-xs">Synthetic new session</p>{session && <ChatControls key={`controls-${epoch}`} session={session} isCloudModel={false} onChange={setSession} only="mode" />}</section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

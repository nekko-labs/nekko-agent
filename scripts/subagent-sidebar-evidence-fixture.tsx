import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { AgentSidebar } from '../apps/desktop/src/renderer/views/WorkspacesView';
import '../apps/desktop/src/renderer/styles.css';

// Synthetic sessions only. No host, credentials, tools or network.
const now = Date.now();
const sessions = [
  { id: 'parent', title: 'Focused Mode Panel' },
  { id: 'ci', title: 'Repair CI and merge PR', parentSessionId: 'parent' },
  { id: 'verify', title: 'Finish verification and land', parentSessionId: 'parent' },
  { id: 'ordinary', title: 'New chat' },
].map((s) => ({ ...s, createdAt: now - 60000, updatedAt: now - 60000, prUrls: [], messageCount: 2, exchangeCount: 1, providerId: 'fixture', modelId: 'fixture-model' }));
const workspace = (id: string) => ({ id: `ws_${id}`, anchor: { kind: 'chat', refId: id }, root: { id: `pane_${id}`, kind: 'chat', refId: id }, activePaneId: `pane_${id}` });
Object.assign(window, { nekko: new Proxy({}, { get: (_t, k: string) => k.startsWith('on') ? () => () => {} : () => Promise.resolve(k === 'pendingInput' ? {} : []) }) });
useStore.setState({ sessions, workspaces: sessions.map((s) => workspace(s.id)), terminals: [], settings: { workspaces: [], showTips: false }, refreshSessions: async () => {}, refreshTerminals: async () => {}, refreshSettings: async () => {} } as any);
Object.assign(window, { evidence: {
  closeParent: () => useStore.setState({ workspaces: sessions.filter((s) => s.id !== 'parent').map((s) => workspace(s.id)) } as any),
  opened: null,
} });
createRoot(document.getElementById('root')!).render(
  <main className="bg-paper" style={{ height: '100vh', display: 'flex' }}>
    <div style={{ width: 340, flexShrink: 0, height: '100%' }}><AgentSidebar selectedId="ci" onOpenChat={(id) => { (window as any).evidence.opened = id; }} /></div>
    <div className="text-ink-faint" style={{ padding: 32 }}>Isolated Agents panel fixture</div>
  </main>,
);

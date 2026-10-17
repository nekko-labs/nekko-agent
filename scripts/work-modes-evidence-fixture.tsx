import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { ChatControls } from '../apps/desktop/src/renderer/components/ChatControls';
import '../apps/desktop/src/renderer/styles.css';

// Synthetic only: no host, credentials, filesystem, provider or network.
let record: any = { id: 'fixture', title: 'Synthetic chat', messages: [], createdAt: 1, updatedAt: 1, executionMode: 'worktree', gitIsolation: true, mode: 'yolo' };
const calls: any[] = [];
const bridge: any = {
  setSessionOptions: async (id: string, patch: any) => { calls.push({ id, patch }); record = { ...record, ...patch }; return { ...record }; },
  updateSettings: async (p: any) => ({ ...useStore.getState().settings, ...p }),
  listTools: async () => [], getMcpStatus: async () => [],
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
useStore.setState({ settings: { defaultChatMode: 'yolo', gitManagement: { mode: 'worktree' }, theme: 'dark' }, toasts: [] } as any);
function Fixture() {
  const [session, setSession] = useState<any>(record);
  Object.assign(window, { evidence: { calls, record: () => record, set: (p: any) => setSession((record = { ...record, ...p })) } });
  return <main data-evidence-route="mode-menu" className="bg-paper" style={{ height: '100vh', display: 'flex', alignItems: 'flex-end', padding: 16 }}>
    <div style={{ width: 520 }}><ChatControls session={session} isCloudModel={false} onChange={(s) => s && setSession(s)} only="mode" /></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { ChatControls } from '../apps/desktop/src/renderer/components/ChatControls';
import '../apps/desktop/src/renderer/styles.css';

// Synthetic only: no host, credentials, filesystem, provider or network.
let record: any = { id: 'fixture', title: 'Synthetic chat', messages: [], createdAt: 1, updatedAt: 1, executionMode: 'worktree', gitIsolation: true, mode: 'guardrails', workMode: 'best-output', workspaceId: 'w1', supportingWorkspaceIds: ['w2'] };
const calls: any[] = [];
let settings: any = {
  defaultChatMode: 'yolo', gitManagement: { mode: 'worktree' }, theme: 'dark', effort: 'high',
  workspaces: [{ id: 'w1', name: 'agent-nekko', path: '/code/agent-nekko', addedAt: 1 }, { id: 'w2', name: 'obsurdian', path: '/code/obsurdian', addedAt: 1 }],
  mcpServers: [{ id: 'context7', name: 'context7', enabled: true, command: 'npx' }, { id: 'higgsfield', name: 'higgsfield', enabled: true, url: 'https://example.invalid' }, { id: 'hypergate', name: 'hypergate', enabled: false, url: 'http://127.0.0.1:7881' }],
  connectors: [{ kind: 'github', connected: true, token: 'synthetic' }, { kind: 'linear', connected: true, token: 'synthetic' }, { kind: 'slack', connected: false }],
};
const tools = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash', 'web_fetch', 'web_search', 'browser'].map((name) => ({ name, description: `Synthetic ${name} tool.` }));
const bridge: any = {
  setSessionOptions: async (id: string, patch: any) => { calls.push({ id, patch }); record = { ...record, ...patch }; return { ...record }; },
  updateSettings: async (p: any) => { calls.push({ settings: p }); settings = { ...settings, ...p }; useStore.setState({ settings } as any); return settings; },
  listTools: async () => tools,
  getMcpStatus: async () => [{ id: 'context7', connected: true, tools: [{}, {}] }, { id: 'higgsfield', connected: false, tools: [], error: 'needs sign-in' }],
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
useStore.setState({ settings, toasts: [], refreshSettings: async () => {} } as any);
function Fixture() {
  const [session, setSession] = useState<any>(record);
  Object.assign(window, { evidence: { calls, record: () => record, set: (p: any) => setSession((record = { ...record, ...p })) } });
  return <main data-evidence-route="mode-panel" className="bg-paper" style={{ height: '100vh', display: 'flex', alignItems: 'flex-end', padding: 16 }}>
    <div style={{ width: 520 }}><ChatControls session={session} isCloudModel={false} modelId="claude-opus-5-5" onChange={(s) => s && setSession(s)} only="mode" /></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

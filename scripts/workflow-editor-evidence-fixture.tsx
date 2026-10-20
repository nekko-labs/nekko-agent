import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { WorkflowEditor } from '../apps/desktop/src/renderer/components/WorkflowEditor';
import '../apps/desktop/src/renderer/styles.css';

// Synthetic only: no host, credentials, filesystem, provider or network.
const providers = [
  { id: 'cloud', kind: 'anthropic', label: 'Anthropic', enabled: true, baseUrl: 'https://api.anthropic.invalid' },
  { id: 'engine', kind: 'llamacpp', label: 'Nekko engine', enabled: true, baseUrl: 'http://127.0.0.1:8080/v1' },
];
const models: Record<string, any[]> = {
  cloud: [{ id: 'claude-sonnet', providerId: 'cloud', name: 'Claude Sonnet' }],
  engine: [{ id: 'qwen3-coder-30b', providerId: 'engine', name: 'Qwen3 Coder 30B' }],
};
const settings: any = {
  theme: 'dark', providers, defaultProviderId: 'cloud', defaultModelId: 'claude-sonnet', favoriteModels: [],
  workspaces: [{ id: 'w1', name: 'agent-nekko', path: '/code/agent-nekko', addedAt: 1 }],
  connectors: [{ kind: 'github', connected: true }],
};
const saved: any[] = [];
const bridge: any = {
  listModels: async (id: string) => models[id] ?? [],
  updateSettings: async () => settings,
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
useStore.setState({ settings, toasts: [], refreshSettings: async () => {} } as any);
const workflow: any = {
  id: 'wf1', name: 'Diagnose failed CI', category: 'Build & test', enabled: true, workspaceId: 'w1', createdAt: 1, updatedAt: 1,
  providerId: 'engine', modelId: 'qwen3-coder-30b', localModelOnly: true, toolAccess: 'read',
  triggers: [{ id: 't1', kind: 'manual' }],
  steps: [
    { id: 'diagnose', name: 'Diagnose', kind: 'prompt', run: 'Read the failed job log tails and explain the failure.' },
    { id: 'review', name: 'Review', kind: 'prompt', run: 'Check the fix is plausible.', providerId: 'cloud', modelId: 'claude-sonnet' },
  ],
};
Object.assign(window, { evidence: { saved } });
createRoot(document.getElementById('root')!).render(
  <main data-evidence-route="workflow-editor" className="bg-paper" style={{ minHeight: '100vh' }}>
    <WorkflowEditor workflow={workflow} workflows={[workflow]} skills={[]} onClose={() => {}} onSave={(p) => { saved.push(p); }} />
  </main>,
);

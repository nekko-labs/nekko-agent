import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CLAUDE_POLICY, type ProviderConfig } from '@nekko-agent/shared';
import { ModelPicker } from '../src/renderer/components/agent-console/ModelPicker';
import { AddProvider } from '../src/renderer/components/providers/AddProvider';
import { useStore } from '../src/renderer/store';
import '../src/renderer/styles.css';

// Synthetic identities and keys only. No host, Claude process or external requests.
const providers: ProviderConfig[] = [
  { id: 'personal', kind: 'claude-code', label: 'Personal', baseUrl: '', enabled: true },
  { id: 'work', kind: 'claude-code', label: 'Work', baseUrl: '', enabled: true, claudeCode: { account: 'work' } },
  { id: 'production', kind: 'anthropic', label: 'Production', baseUrl: 'https://api.anthropic.com', enabled: true, apiKey: 'synthetic-secret-never-render', workspaceId: 'workspace-prod' },
  { id: 'sandbox', kind: 'anthropic', label: 'Sandbox', baseUrl: 'https://api.anthropic.com', enabled: true, apiKey: 'synthetic-secret-never-render' },
  { id: 'aws', kind: 'bedrock', label: 'Client AWS', baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/anthropic', enabled: true },
];
const models = (id: string) => ['personal', 'work'].includes(id)
  ? ['opus', 'sonnet'].map(m => ({ id: m, providerId: id, name: m === 'opus' ? 'Opus' : 'Sonnet' }))
  : id === 'aws' ? [] : [{ id: 'claude-sonnet-4-6', providerId: id, name: 'Sonnet 4.6' }];
const calls: unknown[] = [];
const status = (id = 'personal') => ({ installed: true, version: '2.1.319', loggedIn: true, authMethod: 'claude.ai', auth: 'subscription', email: 'alex@example.test', orgName: id === 'work' ? 'Example organization' : 'Personal', orgId: id === 'work' ? 'org-work' : 'org-personal', subscriptionType: id === 'work' ? 'team' : 'max' });
Object.assign(window, { nekko: {
  listModels: async (id: string) => models(id),
  getLimits: async () => null,
  getLimitsProblem: async () => null,
  onLimitsUpdated: () => () => {},
  getClaudeCodeStatus: async (id?: string, account?: string) => account ? { installed: true, version: '2.1.319', loggedIn: false } : status(id),
  getClaudePolicy: async () => ({ policy: CLAUDE_POLICY }),
  createTerminal: async (opts: unknown) => { calls.push({ terminal: opts }); return { id: 'fixture-terminal' }; },
  runInTerminal: async () => {},
  saveProvider: async (p: unknown) => { calls.push({ saved: p }); },
  testProviderConfig: async () => ({ ok: true, message: 'Synthetic success' }),
} });
useStore.setState({ providers, settings: { providers } as never, refreshProviders: async () => {} });
function Fixture() {
  const [scene, setScene] = useState('picker');
  const [providerId, setProvider] = useState('personal');
  const [modelId, setModel] = useState('sonnet');
  Object.assign(window, { integration: { calls, show: setScene, selection: () => ({ providerId, modelId }) } });
  return <main className="bg-paper text-ink" style={{ padding: 20, minHeight: '100vh' }}>
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <h1 className="mb-3 text-lg font-semibold">{scene === 'picker' ? 'Choose a model' : 'Connect Claude'}</h1>
      {(scene === 'picker' || scene === 'popup') ? <ModelPicker expanded={scene !== 'popup'} open providers={providers} providerId={providerId} modelId={modelId} models={models(providerId)} allowAuto={false} onOpenChange={() => {}} onProvider={id => { calls.push({ provider: id }); setProvider(id); }} onModel={(id, model) => { calls.push({ model, provider: id }); setProvider(id); setModel(model); }} />
        : <AddProvider fixedKind={scene === 'api' ? 'anthropic' : 'claude-code'} onDone={() => {}} />}
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

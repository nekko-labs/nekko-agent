import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import { ModelPicker } from '../src/renderer/components/agent-console/ModelPicker';
import { useStore } from '../src/renderer/store';
import '../src/renderer/styles.css';

// Synthetic accounts only: one email with a personal Claude plan and an
// organization seat, an API key, a ChatGPT plan and a local server. No host,
// Claude process or network.
const providers: ProviderConfig[] = [
  { id: 'personal', kind: 'claude-code', label: 'Claude subscription', baseUrl: '', enabled: true },
  { id: 'acme', kind: 'claude-code', label: 'Claude subscription · Work', baseUrl: '', enabled: true, claudeCode: { account: 'work' } },
  { id: 'production', kind: 'anthropic', label: 'Production', baseUrl: 'https://api.anthropic.com', enabled: true, apiKey: 'synthetic-secret-never-render' },
  { id: 'gpt', kind: 'chatgpt', label: 'ChatGPT (subscription)', baseUrl: '', enabled: true, auth: 'subscription', tokenKey: 'chatgpt:gpt' },
  { id: 'lm', kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true },
];
const catalog: Record<string, ModelInfo[]> = {
  personal: [{ id: 'opus', providerId: 'personal', name: 'Claude Opus' }, { id: 'sonnet', providerId: 'personal', name: 'Claude Sonnet' }, { id: 'haiku', providerId: 'personal', name: 'Claude Haiku' }],
  acme: [{ id: 'opus', providerId: 'acme', name: 'Claude Opus' }, { id: 'sonnet', providerId: 'acme', name: 'Claude Sonnet' }],
  production: [{ id: 'claude-opus-4-7', providerId: 'production', name: 'Claude Opus 4.7' }, { id: 'claude-sonnet-4-6', providerId: 'production', name: 'Claude Sonnet 4.6' }],
  gpt: [{ id: 'gpt-5.5', providerId: 'gpt', name: 'GPT-5.5' }, { id: 'gpt-5.5-mini', providerId: 'gpt', name: 'GPT-5.5 mini' }],
  lm: [{ id: 'qwen3-8b', providerId: 'lm', name: 'Qwen3 8B', loaded: true }, { id: 'gemma-3-12b', providerId: 'lm', name: 'Gemma 3 12B' }],
};
const status = (id?: string) => id === 'acme'
  ? { installed: true, version: '2.1.319', loggedIn: true, authMethod: 'claude.ai', auth: 'subscription', email: 'alex@example.test', orgName: 'Acme Inc', orgId: 'org-acme', subscriptionType: 'team' }
  : { installed: true, version: '2.1.319', loggedIn: true, authMethod: 'claude.ai', auth: 'subscription', email: 'alex@example.test', orgName: "alex@example.test's Organization", orgId: 'org-personal', subscriptionType: 'max' };
const now = Date.now();
const limits = {
  updatedAt: now, staleAfterMs: 600000,
  windows: [
    { id: 'session', label: '5 hours', scope: 'session', usedPercent: 62, status: 'allowed', resetAt: now + 3600000 },
    { id: 'week', label: 'Week', scope: 'week', usedPercent: 21, status: 'allowed', resetAt: now + 86400000 * 3 },
  ],
};
const calls: unknown[] = [];
Object.assign(window, { nekko: {
  listModels: async (id: string) => catalog[id] ?? [],
  getLimits: async (key: string) => (key.includes('personal') ? limits : null),
  getLimitsProblem: async () => null,
  onLimitsUpdated: () => () => {},
  getClaudeCodeStatus: async (id?: string) => status(id),
  oauthStatus: async () => ({ tokenKey: 'chatgpt:gpt', connected: true, accountEmail: 'alex@example.test' }),
  onOAuthStatus: () => () => {},
  updateSettings: async () => ({}),
} });
useStore.setState({ providers, settings: { providers, favoriteModels: [] } as never, refreshProviders: async () => {}, refreshSettings: async () => {} } as never);

function Fixture() {
  const [providerId, setProvider] = useState('personal');
  const [modelId, setModel] = useState('opus');
  const [open, setOpen] = useState(true);
  Object.assign(window, { integration: { calls, selection: () => ({ providerId, modelId }), open: () => setOpen(true) } });
  return <main className="bg-paper text-ink" style={{ minHeight: '100vh', padding: 16, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <ModelPicker open={open} onOpenChange={setOpen} providers={providers} providerId={providerId} modelId={modelId} models={catalog[providerId]} recent={[]}
        onProvider={(id) => { calls.push({ provider: id }); setProvider(id); }}
        onModel={(id, model) => { calls.push({ provider: id, model }); setProvider(id); setModel(model); }} />
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

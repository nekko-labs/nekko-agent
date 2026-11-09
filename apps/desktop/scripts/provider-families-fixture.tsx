import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import { ModelsView } from '../src/renderer/views/ModelsView';
import { useStore } from '../src/renderer/store';
import '../src/renderer/styles.css';

// The cloud half of the Models page with synthetic accounts: one email with a
// personal Claude plan and an organization seat, an API key, and a ChatGPT plan.
// No host, Claude process or network; unknown bridge calls answer null.
const providers: ProviderConfig[] = [
  { id: 'personal', kind: 'claude-code', label: 'Claude subscription', baseUrl: '', enabled: true },
  { id: 'acme', kind: 'claude-code', label: 'Claude subscription · Work', baseUrl: '', enabled: true, claudeCode: { account: 'work' } },
  { id: 'production', kind: 'anthropic', label: 'Production', baseUrl: 'https://api.anthropic.com', enabled: true, apiKey: 'synthetic-secret-never-render' },
  { id: 'gpt', kind: 'chatgpt', label: 'ChatGPT (subscription)', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true, auth: 'subscription', tokenKey: 'chatgpt:gpt' },
];
const catalog: Record<string, ModelInfo[]> = {
  personal: [{ id: 'opus', providerId: 'personal', name: 'Claude Opus' }, { id: 'sonnet', providerId: 'personal', name: 'Claude Sonnet' }, { id: 'haiku', providerId: 'personal', name: 'Claude Haiku' }],
  acme: [{ id: 'opus', providerId: 'acme', name: 'Claude Opus' }, { id: 'sonnet', providerId: 'acme', name: 'Claude Sonnet' }],
  production: [{ id: 'claude-opus-4-7', providerId: 'production', name: 'Claude Opus 4.7' }, { id: 'claude-sonnet-4-6', providerId: 'production', name: 'Claude Sonnet 4.6' }],
  gpt: [{ id: 'gpt-5.5', providerId: 'gpt', name: 'GPT-5.5' }, { id: 'gpt-5.5-mini', providerId: 'gpt', name: 'GPT-5.5 mini' }],
};
const status = (id?: string) => id === 'acme'
  ? { installed: true, version: '2.1.319', loggedIn: true, authMethod: 'claude.ai', auth: 'subscription', email: 'alex@example.test', orgName: 'Acme Inc', orgId: 'org-acme', subscriptionType: 'team' }
  : { installed: true, version: '2.1.319', loggedIn: true, authMethod: 'claude.ai', auth: 'subscription', email: 'alex@example.test', orgName: "alex@example.test's Organization", orgId: 'org-personal', subscriptionType: 'max' };
const now = Date.now();
const limits = { updatedAt: now, staleAfterMs: 600000, windows: [
  { id: 'session', label: '5 hours', scope: 'session', usedPercent: 62, status: 'allowed', resetAt: now + 3600000 },
  { id: 'week', label: 'Week', scope: 'week', usedPercent: 21, status: 'allowed', resetAt: now + 86400000 * 3 },
] };
const known: Record<string, unknown> = {
  listModels: async (id: string) => catalog[id] ?? [],
  listModelsStatus: async (id: string) => ({ models: catalog[id] ?? [] }),
  testProvider: async () => ({ ok: true, message: 'Synthetic' }),
  getClaudeCodeStatus: async (id?: string) => status(id),
  getClaudePolicy: async () => null,
  getLimits: async (key: string) => (key.includes('personal') ? limits : null),
  oauthStatus: async () => ({ tokenKey: 'chatgpt:gpt', connected: true, accountEmail: 'alex@example.test' }),
  discoverProviders: async () => providers,
  updateSettings: async () => ({}),
  saveProvider: async () => {},
};
Object.assign(window, { nekko: new Proxy(known, { get: (t, k: string) => t[k] ?? (k.startsWith('on') ? () => () => {} : async () => null) }) });
useStore.setState({ providers, activeModelId: 'opus', settings: { providers, favoriteModels: ['personal::opus', 'acme::opus'] } as never, refreshProviders: async () => {}, refreshSettings: async () => {} } as never);

createRoot(document.getElementById('root')!).render(
  <main className="bg-paper text-ink" style={{ minHeight: '100vh', padding: 24, maxWidth: 820 }}>
    <h2 className="mb-4 text-xl font-semibold">Cloud providers</h2>
    <ModelsView />
  </main>,
);

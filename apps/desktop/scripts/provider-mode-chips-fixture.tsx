// Synthetic provider cards only. No live host, credentials or network access.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ModelsView } from '../src/renderer/views/ModelsView';
import { useStore } from '../src/renderer/store';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../src/renderer/styles.css';

const provider = (id: string, kind: string, label: string, extra = {}) => ({ id, kind, label, enabled: true, baseUrl: '', ...extra });
const groups: Record<string, any[]> = {
  subscriptions: [provider('claude-plan', 'claude-code', 'Claude', { claudeCode: {} }), provider('chatgpt', 'chatgpt', 'ChatGPT', { auth: 'subscription', tokenKey: 'chatgpt' })],
  api: [provider('anthropic', 'anthropic', 'Claude API'), provider('openai', 'openai', 'OpenAI'), provider('openrouter', 'openrouter', 'OpenRouter', { auth: 'apikey', tokenKey: 'router' })],
  code: [provider('claude-key', 'claude-code', 'Claude Code API'), provider('claude-cloud', 'claude-code', 'Claude Code Cloud')],
  local: [provider('local', 'lmstudio', 'LM Studio', { baseUrl: 'http://localhost:1234' })],
};
const statuses: Record<string, any> = {
  'claude-plan': { installed: true, version: '2.1.319', loggedIn: true, auth: 'subscription', authMethod: 'claude.ai', email: 'person@example.test', subscriptionType: 'pro' },
  'claude-key': { installed: true, version: '2.1.319', loggedIn: true, auth: 'api_key', authMethod: 'api_key' },
  'claude-cloud': { installed: true, version: '2.1.319', loggedIn: true, auth: 'cloud', authMethod: 'bedrock', apiProvider: 'bedrock' },
};
let providers = groups.subscriptions;
const settings: any = { providers, favoriteModels: [], agent: {}, theme: 'dark' };
const bridge: any = {
  listProviders: async () => providers,
  listModels: async () => [], listModelsStatus: async () => ({ models: [] }),
  testProvider: async () => ({ ok: true }),
  getClaudeCodeStatus: async (id: string) => statuses[id] ?? { installed: false, message: 'Not installed' },
  oauthStatus: async () => ({ connected: true, state: 'connected', provider: 'chatgpt' }),
  runtimeStatus: async () => null, runtimeFacts: async () => [], getLimits: async () => null, lmsAvailable: async () => ({ available: false }),
};
(window as any).nekko = new Proxy(bridge, { get(t, key: string) { if (key in t) return t[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } });
const root = createRoot(document.getElementById('root')!);
(window as any).modeChipsFixture = {
  changeClaudeAuth(auth: string) {
    statuses['claude-plan'] = { ...statuses['claude-plan'], installed: true, version: '2.1.319', loggedIn: auth !== 'signed_out', auth, authMethod: auth };
    window.dispatchEvent(new Event('focus'));
  },
  show(group: string) {
    providers = groups[group];
    settings.providers = providers;
    useStore.setState({ providers, settings, activeModelId: 'fixture', refreshProviders: async () => {} } as any);
    root.render(<main style={{ padding: 20, minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)' }}>
      <h2 className="models-section-heading" style={{ marginBottom: 20 }}>{group === 'local' ? 'Local servers' : 'Cloud providers'}</h2>
      <ModelsView key={group} localOnly={group === 'local'} />
    </main>);
  },
};
(window as any).modeChipsFixture.show('subscriptions');

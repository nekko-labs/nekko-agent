import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { AddProvider } from '../src/renderer/components/providers/AddProvider';
import { ProviderChoices } from '../src/renderer/components/providers/ProviderChoices';
import { ClaudePlanSheet } from '../src/renderer/components/claude/ClaudeAgent';
import { ScheduleTaskModal } from '../src/renderer/components/ScheduleTaskModal';
import { AppNotices } from '../src/renderer/components/AppNotices';
import { ModelsView } from '../src/renderer/views/ModelsView';
import { ProviderLimitsDock } from '../src/renderer/components/ProviderLimitsDock';
import { CLAUDE_POLICY } from '@nekko-agent/shared';
import '../src/renderer/styles.css';

// Synthetic data only: this fixture never connects to a host, nekkod or Claude Code.
const statuses: Record<string, unknown> = {
  missing: { installed: false, message: 'claude was not found on PATH' },
  signedOut: { installed: true, version: '2.1.284', loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
  plan: { installed: true, version: '2.1.284', loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', auth: 'subscription' },
  apiKey: { installed: true, version: '2.1.284', loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', auth: 'api_key' },
};
let codeStatus: unknown = statuses.missing;
// A Claude plan card the startup migration retired, beside a Claude Agent and an API-key Claude.
const providers = [
  { id: 'claude-plan', kind: 'anthropic', label: 'Claude (subscription)', baseUrl: 'https://api.anthropic.com', auth: 'subscription', enabled: false },
  { id: 'claude-agent', kind: 'claude-code', label: 'Claude Agent', baseUrl: '', enabled: true },
  { id: 'claude-api', kind: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.com', apiKey: 'fixture-key', enabled: true },
];
const notice = {
  id: 'claude-sign-in-changed',
  title: 'Claude sign-in has changed',
  body: "To follow Anthropic's terms, Nekko Agent no longer signs in to Claude plans directly, and we've deleted the saved Claude sign-in from this computer. Your chats are safe.",
  points: ['Keep using your plan: connect Claude Agent (uses your Claude Code install).', 'Get every feature: add an Anthropic API key or cloud account.'],
  actions: [{ id: 'connect-claude-agent', label: 'Connect Claude Agent' }, { id: 'add-api-key', label: 'Add API key' }, { id: 'what-changed', label: 'What changed?' }],
  createdAt: 1,
};
const calls: unknown[] = [];
const bridge: Record<string, unknown> = {
  getClaudeCodeStatus: async () => codeStatus,
  getClaudePolicy: async () => ({ policy: CLAUDE_POLICY, override: null, preview: null }),
  getClaudeCapability: async () => ({
    claude: true,
    auth: 'subscription',
    state: 'awaiting_approval',
    reason: 'unattended_needs_api_key',
    message: 'Scheduled runs need Claude with an API key.',
  }),
  listProviders: async () => providers,
  testProvider: async () => ({ ok: true, message: 'Connected' }),
  listModelsStatus: async () => ({ models: [], errors: [] }),
  discoverProviders: async () => [],
  lmsAvailable: async () => false,
  oauthStatus: async () => [],
  listModels: async () => [],
  listTasks: async () => [],
  listInstalledModels: async () => [],
  listServers: async () => [],
  getLimitsProblem: async () => null,
  getSettings: async () => ({ notices: [notice], providers }),
  saveProvider: async (p: unknown) => {
    calls.push({ method: 'saveProvider', p });
  },
};
Object.assign(window, {
  nekko: new Proxy(bridge, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key.startsWith('on')) return () => () => {};
      return () => Promise.resolve(null);
    },
  }),
});

type Scene = 'choices' | 'missing' | 'signedOut' | 'plan' | 'apiKey' | 'sheet' | 'schedule' | 'notice' | 'retired' | 'limits' | 'connect';

function Fixture() {
  const [scene, setScene] = useState<Scene>('choices');
  Object.assign(window, {
    integration: {
      show: (name: Scene) => {
        if (name in statuses) codeStatus = statuses[name];
        useStore.setState({ claudePlanSheet: name === 'sheet', providers: providers as never, settings: (name === 'notice' ? { notices: [notice] } : {}) as never, addProviderKind: name === 'connect' ? 'claude-code' : null });
        if (name === 'connect') codeStatus = statuses.signedOut;
        setScene(name);
      },
      calls,
    },
  });
  return (
    <div className="bg-paper" style={{ minHeight: '100vh', padding: 24 }} key={scene}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        {scene === 'choices' && <ProviderChoices value="claude-code" onPick={() => {}} />}
        {['missing', 'signedOut', 'plan', 'apiKey'].includes(scene) && (
          <AddProvider fixedKind="claude-code" onDone={() => {}} />
        )}
        {(scene === 'retired' || scene === 'connect') && <ModelsView />}
        {scene === 'limits' && <ProviderLimitsDock standalone />}
        {scene === 'schedule' && (
          <ScheduleTaskModal providerId="claude-agent" initialPrompt="Run the test suite each night." onClose={() => {}} />
        )}
      </div>
      <ClaudePlanSheet />
      {scene === 'notice' && <AppNotices />}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

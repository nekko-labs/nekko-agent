import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { AddProvider } from '../src/renderer/components/providers/AddProvider';
import { ProviderChoices } from '../src/renderer/components/providers/ProviderChoices';
import { ClaudePlanSheet } from '../src/renderer/components/claude/ClaudeAgent';
import { ClaudeSetup } from '../src/renderer/components/claude/ClaudeSetup';
import { ScheduleTaskModal } from '../src/renderer/components/ScheduleTaskModal';
import { AppNotices } from '../src/renderer/components/AppNotices';
import { ModelsView } from '../src/renderer/views/ModelsView';
import { ProviderLimitsDock } from '../src/renderer/components/ProviderLimitsDock';
import { ClaudePlanFeaturesSection } from '../src/renderer/views/SettingsView';
import { CLAUDE_POLICY } from '@nekko-agent/shared';
import '../src/renderer/styles.css';

// Synthetic data only: this fixture never connects to a host, nekkod or Claude Code.
const statuses: Record<string, unknown> = {
  missing: { installed: false, message: 'claude was not found on PATH' },
  signedOut: { installed: true, version: '2.1.284', loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
  plan: { installed: true, version: '2.1.284', loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', auth: 'subscription', email: 'me@example.com', orgId: 'org-me', subscriptionType: 'max' },
  work: { installed: true, version: '2.1.284', loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', auth: 'subscription', email: 'me@nekkolabs.com', orgId: 'org-nekko', subscriptionType: 'team' },
  side: { installed: true, version: '2.1.284', loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', auth: 'subscription', email: 'side@example.com', orgId: 'org-side', subscriptionType: 'pro' },
  apiKey: { installed: true, version: '2.1.284', loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', auth: 'api_key' },
};
let codeStatus: unknown = statuses.missing;
// What the "another account" folder reports, per scene.
let anotherStatus: unknown = statuses.work;
// A Claude plan card the startup migration retired, beside subscription and API accounts.
const allProviders = [
  { id: 'claude-plan', kind: 'anthropic', label: 'Claude (subscription)', baseUrl: 'https://api.anthropic.com', auth: 'subscription', enabled: false },
  { id: 'claude-agent', kind: 'claude-code', label: 'Claude subscription', baseUrl: '', enabled: true },
  { id: 'claude-work', kind: 'claude-code', label: 'Claude subscription · Work', baseUrl: '', enabled: true, claudeCode: { account: 'work' } },
  { id: 'claude-api', kind: 'anthropic', label: 'Nekko Labs key', baseUrl: 'https://api.anthropic.com', apiKey: 'fixture-key', enabled: true },
  { id: 'claude-bedrock', kind: 'bedrock', label: 'Client AWS', baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/anthropic', apiKey: 'fixture-key', enabled: true },
];
let providers = allProviders;
const byProvider: Record<string, unknown> = { 'claude-agent': statuses.plan, 'claude-work': statuses.work };
const notice = {
  id: 'claude-sign-in-changed',
  title: 'Claude sign-in has changed',
  body: "To follow Anthropic's terms, Nekko Agent no longer signs in to Claude plans directly, and we've deleted the saved Claude sign-in from this computer. Your chats are safe.",
  points: ['Keep using your plan: choose Claude, then Subscription, which runs your installed Claude Code.', 'Get every feature: add an Anthropic API key or cloud account.'],
  actions: [{ id: 'connect-claude-agent', label: 'Use my subscription' }, { id: 'add-api-key', label: 'Add API key' }, { id: 'what-changed', label: 'What changed?' }],
  createdAt: 1,
};
const calls: unknown[] = [];
const bridge: Record<string, unknown> = {
  getClaudeCodeStatus: (id?: string, account?: string) =>
    codeStatus === 'pending' && !id ? new Promise(() => {}) : Promise.resolve(id ? byProvider[id] : account ? anotherStatus : codeStatus),
  createTerminal: async () => ({ id: 'fixture-term', title: 'Install Claude Code', running: true }),
  runInTerminal: async (_id: string, command: string) => {
    calls.push({ method: 'runInTerminal', command });
  },
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

type Scene = 'choices' | 'checking' | 'missing' | 'signedOut' | 'plan' | 'apiKey' | 'api' | 'connected' | 'another' | 'confirm' | 'blocked' | 'sheet' | 'schedule' | 'notice' | 'retired' | 'limits' | 'connect';

function Fixture() {
  const [scene, setScene] = useState<Scene>('choices');
  Object.assign(window, {
    integration: {
      show: (name: Scene) => {
        if (name in statuses) codeStatus = statuses[name];
        if (name === 'checking') codeStatus = 'pending';
        if (name === 'api' || name === 'connected') codeStatus = statuses.plan;
        if (['another', 'confirm', 'blocked'].includes(name)) codeStatus = statuses.plan;
        anotherStatus = name === 'confirm' ? statuses.side : name === 'blocked' ? statuses.plan : statuses.work;
        // A first-time setup has no Claude accounts yet; the rest show the existing ones.
        providers = ['checking', 'missing', 'signedOut', 'plan', 'apiKey', 'api'].includes(name) ? [] : ['another', 'confirm', 'blocked'].includes(name) ? allProviders.filter((p) => p.id === 'claude-agent') : allProviders;
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
        {scene === 'choices' && <ProviderChoices value="anthropic" onPick={() => {}} />}
        {['checking', 'missing', 'signedOut', 'plan', 'apiKey', 'another', 'confirm', 'blocked'].includes(scene) && (
          <AddProvider fixedKind="claude-code" onDone={() => {}} />
        )}
        {scene === 'api' && <AddProvider initialKind="anthropic" onDone={() => {}} />}
        {scene === 'connected' && <ClaudeSetup initialChoice="subscription" apiOpen={false} connected={{ title: 'Claude is connected', detail: 'Using your Claude subscription through Claude Code 2.1.284, signed in as me@example.com · Max plan.' }} onChoice={() => {}} onConnectApi={() => {}} onConnected={() => {}} onDone={() => {}} />}
        {(scene === 'retired' || scene === 'connect') && <ModelsView />}
        {scene === 'limits' && <ProviderLimitsDock standalone />}
        {(scene === 'planOff' || scene === 'planOn') && (
          <ClaudePlanFeaturesSection settings={{ claudePlanFeaturesApproved: scene === 'planOn' } as never} update={() => {}} />
        )}
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

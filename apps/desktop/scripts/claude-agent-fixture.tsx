import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { AddProvider } from '../src/renderer/components/providers/AddProvider';
import { ProviderChoices } from '../src/renderer/components/providers/ProviderChoices';
import { ClaudePlanSheet } from '../src/renderer/components/claude/ClaudeAgent';
import { ScheduleTaskModal } from '../src/renderer/components/ScheduleTaskModal';
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

type Scene = 'choices' | 'missing' | 'signedOut' | 'plan' | 'apiKey' | 'sheet' | 'schedule';

function Fixture() {
  const [scene, setScene] = useState<Scene>('choices');
  Object.assign(window, {
    integration: {
      show: (name: Scene) => {
        if (name in statuses) codeStatus = statuses[name];
        useStore.setState({ claudePlanSheet: name === 'sheet' });
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
        {scene === 'schedule' && (
          <ScheduleTaskModal providerId="claude-agent" initialPrompt="Run the test suite each night." onClose={() => {}} />
        )}
      </div>
      <ClaudePlanSheet />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

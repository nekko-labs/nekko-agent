import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { ChatControls } from '../apps/desktop/src/renderer/components/ChatControls';
import '../apps/desktop/src/renderer/styles.css';

// Privacy Shield evidence. Synthetic only: no host, credentials, filesystem,
// provider or network. The preview is a canned copy of what `privacy:preview`
// answers for this chat (crates/nekko-privacy computes the real one).
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
let record: any = {
  id: 'fixture', title: 'Customer reply', createdAt: 1, updatedAt: 1, executionMode: 'worktree', gitIsolation: true, mode: 'guardrails',
  privacy: params.get('shield') === 'off' ? undefined : { mode: 'redact', allow: ['+81 90-1234-5678'] },
  messages: [{ id: 'u0', role: 'user', content: 'Ticket from jane.doe@example.com (+81 90-1234-5678), key sk-ant-api03-SYNTHETICabcdefghijklmnop', createdAt: 1 }],
};
let settings: any = { theme, defaultChatMode: 'guardrails', privacyTerms: ['Acme Corp'] };
const draft = 'Draft a reply to jane.doe@example.com about the Acme Corp renewal, cc bob@example.com';
const preview = () => ({
  enabled: record.privacy?.mode === 'redact',
  reach: 'cloud',
  draft: 'Draft a reply to [PII_EMAIL_1] about the [PII_TERM_1] renewal, cc [PII_EMAIL_2]',
  findings: [
    { kind: 'term', value: 'Acme Corp', token: '[PII_TERM_1]', count: 1, inDraft: true, inChat: false },
    { kind: 'email', value: 'jane.doe@example.com', token: '[PII_EMAIL_1]', count: 2, inDraft: true, inChat: true },
    { kind: 'secret', value: 'sk-ant-api03-SYNTHETICabcdefghijklmnop', token: '[PII_SECRET_1]', count: 1, inDraft: false, inChat: true },
    { kind: 'email', value: 'bob@example.com', token: '[PII_EMAIL_2]', count: 1, inDraft: true, inChat: false },
  ],
  allowed: [{ kind: 'phone', value: '+81 90-1234-5678' }],
  disabledKinds: ['ip'],
  terms: settings.privacyTerms,
  kinds: ['email', 'phone', 'card', 'ssn', 'my-number', 'ip', 'secret', 'username', 'term'],
});
const bridge: any = {
  setSessionOptions: async (_id: string, patch: any) => { record = { ...record, ...patch }; return { ...record }; },
  updateSettings: async (p: any) => { settings = { ...settings, ...p }; useStore.setState({ settings } as any); return settings; },
  previewPrivacy: async () => preview(),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
useStore.setState({ settings, toasts: [], refreshSettings: async () => {} } as any);
function Fixture() {
  const [session, setSession] = useState<any>(record);
  return <main data-evidence-route="privacy-shield" className="bg-paper" style={{ height: '100vh', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 16 }}>
    <div className="card" style={{ padding: 8 }}>
      <ChatControls session={session} isCloudModel modelId="claude-opus-5-5" draft={draft} onChange={(s) => s && setSession(s)} only="privacy" />
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

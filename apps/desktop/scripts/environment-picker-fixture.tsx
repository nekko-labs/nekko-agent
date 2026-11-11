import React from 'react';
import { createRoot } from 'react-dom/client';
import { FolderPicker } from '../src/renderer/components/FolderPicker';
import { QuestionCard } from '../src/renderer/components/QuestionCard';
import { useStore } from '../src/renderer/store';
import '../src/renderer/styles.css';

// Synthetic folders, repositories and connectors only (#2404). No host, git or network.
const workspaces = [
  { id: 'ws_notes', name: 'design-notes', path: 'C:\\Users\\alex\\code\\design-notes', addedAt: 0 },
  { id: 'ws_site', name: 'marketing-site', path: 'C:\\Users\\alex\\code\\marketing-site', addedAt: 0 },
  { id: 'ws_atlas', name: 'atlas', path: 'C:\\Users\\alex\\nekko-repos\\acme\\atlas', addedAt: 0, repo: { provider: 'github', fullName: 'acme/atlas', webUrl: 'https://github.com/acme/atlas' } },
];
const repo = (fullName: string, description: string, priv = false, provider = 'github') => ({
  provider, id: fullName, fullName, cloneUrl: `https://github.com/${fullName}.git`, webUrl: `https://github.com/${fullName}`,
  defaultBranch: 'main', private: priv, description, updatedAt: '2026-11-08T10:00:00Z',
});
const repos = [
  repo('acme/atlas', 'Customer dashboard and admin console'),
  repo('acme/billing-service', 'Invoices, payments and the Stripe webhooks', true),
  repo('acme/mobile', 'iPhone and Android apps', true),
  repo('acme/docs', 'Public documentation site'),
  repo('alex/dotfiles', 'Shell, editor and git config'),
  repo('platform/infra', 'Terraform for the shared AWS accounts', true, 'gitlab'),
];
const connected = [{ kind: 'github', connected: true, token: 'synthetic-secret-never-render' }, { kind: 'gitlab', connected: true, token: 'synthetic-secret-never-render' }];
const calls: unknown[] = [];
let syncFolder = '';

Object.assign(window, { nekko: {
  listRepos: async (query: string) => { calls.push({ listRepos: query }); return { repos, providers: [{ kind: 'github' }, { kind: 'gitlab' }] }; },
  cloneRepo: async (r: { fullName: string }) => {
    calls.push({ cloneRepo: r.fullName });
    // #2561: no copy here and no repositories folder yet, so the list asks where they sync.
    if (!syncFolder) return { needsFolder: true, suggested: '/Users/alex/nekko-repos' };
    await new Promise((resolve) => setTimeout(resolve, 60000));
    return { workspaces, folderId: null, path: '' };
  },
  setSessionWorkspace: async () => null,
  setSessionSupportingWorkspaces: async () => null,
  pickFolder: async () => null,
  addWorkspaceByPath: async () => workspaces,
  removeWorkspace: async () => workspaces,
  getSession: async () => null,
  updateSettings: async (patch: { repoCloneDir?: string }) => { calls.push({ updateSettings: patch }); syncFolder = patch.repoCloneDir ?? syncFolder; return {}; },
} });

const setConnected = (on: boolean) => useStore.setState((s) => ({ settings: { ...(s.settings as object), connectors: on ? connected : [] } as never }));
useStore.setState({
  settings: { workspaces, defaultWorkspaceIds: ['ws_notes'], connectors: connected, providers: [] } as never,
  sessions: [{ id: 's1', title: 'Fix the invoice totals', workspaceId: 'ws_notes', supportingWorkspaceIds: ['ws_atlas'], updatedAt: 0 }] as never,
  refreshSettings: async () => {}, refreshSessions: async () => {}, setView: (v: string) => calls.push({ view: v }),
} as never);

const question = {
  callId: 'call_env',
  askedAt: 0,
  questions: [{
    id: 'q1',
    header: 'Project',
    question: 'billing-service isn’t in this chat’s environment. Where is it?',
    options: [
      { label: 'Search this computer', description: 'I look for a billing-service folder in your usual code folders' },
      { label: 'Use C:\\Users\\alex\\code\\billing-service', description: 'Found on this computer', action: { kind: 'addFolder', path: 'C:\\Users\\alex\\code\\billing-service' } },
      { label: 'Choose the folder…', description: 'Pick it yourself', action: { kind: 'pickFolder' } },
      { label: 'Add it from GitHub or GitLab', description: 'Clone it into the environment', action: { kind: 'connectRepo' } },
    ],
  }],
};
const actions = {
  run: async () => '(Added.)',
  addRepo: async () => new Promise<string>(() => {}),
  connect: () => calls.push({ view: 'connectors' }),
};

function Fixture() {
  Object.assign(window, { integration: { calls, setConnected } });
  return <main className="bg-paper text-ink" style={{ minHeight: '100vh', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div data-fixture-question style={{ maxWidth: 640 }}>
      <QuestionCard request={question as never} onAnswer={async () => {}} onSkip={async () => {}} actions={actions as never} />
    </div>
    <div style={{ flex: 1 }} />
    <div className="card" style={{ maxWidth: 640, padding: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="text-xs text-ink-faint">Composer</span>
      <div className="composer-folders min-w-0">
        <FolderPicker sessionId="s1" session={null} onChange={() => {}} selectedSummary />
      </div>
    </div>
    {/* #2561: a sandbox chat whose repository lives in its sandbox. */}
    <div className="card" data-fixture-sandbox style={{ maxWidth: 640, padding: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="text-xs text-ink-faint">Sandbox chat</span>
      <div className="composer-folders min-w-0">
        <FolderPicker sessionId="s1" onChange={() => {}} selectedSummary session={{ id: 's1', title: 'Try the migration', executionMode: 'sandbox', workspaceId: 'ws_notes',
          sandboxRepos: [{ provider: 'github', fullName: 'acme/billing-service', cloneUrl: 'https://github.com/acme/billing-service.git', webUrl: '' }] } as never} />
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);

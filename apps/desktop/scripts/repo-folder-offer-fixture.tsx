import React from 'react';
import { createRoot } from 'react-dom/client';
import { RepoFolderOffer } from '../src/renderer/components/RepoFolderOffer';
import { addFolderToChat } from '../src/renderer/sessionFolders';
import { useStore } from '../src/renderer/store';
import '../src/renderer/styles.css';

// The one-time repositories folder offer: the real add-folder flow and card on
// a synthetic bridge. No host, filesystem, git or network.
const workspaces = [{ id: 'ws_app', name: 'billing-app', path: '/Users/alex/code/billing-app', addedAt: 0 }];
const calls: unknown[] = [];

Object.assign(window, { nekko: {
  pickFolder: async () => '/Users/alex/code/billing-app',
  addWorkspaceByPath: async () => workspaces,
  setSessionWorkspace: async () => null,
  setSessionSupportingWorkspaces: async () => ({ id: 's1' }),
  suggestRepoFolder: async (path: string) => { calls.push({ suggestRepoFolder: path }); return { suggested: '/Users/alex/code' }; },
  updateSettings: async (patch: unknown) => { calls.push({ updateSettings: patch }); return {}; },
} });

useStore.setState({
  settings: { workspaces: [], connectors: [], providers: [] } as never,
  refreshSettings: async () => {}, refreshSessions: async () => {},
} as never);

function Chat() {
  const offer = useStore((s) => (s.repoFolderOffer?.sessionId === 's1' ? s.repoFolderOffer.suggested : null));
  return <main className="bg-paper text-ink" style={{ minHeight: '100vh', padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <p className="mx-auto w-full max-w-3xl text-sm text-ink-soft">Fix the invoice totals in the billing app.</p>
    <div style={{ flex: 1 }} />
    {offer && <RepoFolderOffer suggested={offer} />}
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-xl p-2" style={{ background: 'var(--surface)' }}>
      <button type="button" className="btn btn-ghost text-xs" data-fixture-add onClick={() => void addFolderToChat('s1', null, 'primary')}>Add folder…</button>
      <span className="text-xs text-ink-faint">Composer</span>
    </div>
  </main>;
}

Object.assign(window, { integration: { calls } });
createRoot(document.getElementById('root')!).render(<Chat />);

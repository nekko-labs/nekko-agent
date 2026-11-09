import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type RemoteRepo, type RemoteRepoList, type WorkspaceFolder } from '@nekko-agent/shared';
import { ConnectorIcon } from '../connectorIcons.js';
import { PlugIcon, SearchIcon } from '../icons.js';
import { useStore } from '../store.js';
import { hasRepoProvider } from '../sessionFolders.js';

const PROVIDER_LABEL = { github: 'GitHub', gitlab: 'GitLab' } as const;

/** The repositories matching `query`, newest first within each provider as listed. */
export function filterRepos(repos: RemoteRepo[], query: string): RemoteRepo[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter((r) => r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
}

/** The saved folder already holding a clone of `repo`, if any. */
export function savedClone(folders: WorkspaceFolder[], repo: Pick<RemoteRepo, 'provider' | 'fullName'>): WorkspaceFolder | undefined {
  return folders.find((f) => f.repo?.provider === repo.provider && f.repo.fullName.toLowerCase() === repo.fullName.toLowerCase());
}

/** Shown in place of the list when no git provider is connected. */
export function ConnectRepos({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="px-3 py-2">
      <p className="text-2xs text-ink-faint">Connect GitHub or GitLab to add your repositories to this chat.</p>
      <button type="button" className="btn mt-2 flex items-center gap-2 text-xs" onClick={onConnect}>
        <PlugIcon className="h-3.5 w-3.5" /> Connect repositories
      </button>
    </div>
  );
}

/**
 * Search the connected accounts' repositories and pick one. `onPick` clones
 * and wires it in; the row shows progress and any failure inline, since a
 * clone can take a while.
 */
export function RepoBrowser({ onPick, onConnect, autoFocus = true }: {
  onPick: (repo: RemoteRepo) => Promise<void>;
  onConnect: () => void;
  autoFocus?: boolean;
}) {
  const connected = hasRepoProvider(useStore((s) => s.settings?.connectors));
  const saved = useStore((s) => s.settings?.workspaces) ?? [];
  const [query, setQuery] = useState('');
  const [list, setList] = useState<RemoteRepoList | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // One read on open, then a server search (GitLab searches its own side) a
  // moment after typing stops. The last list stays on screen meanwhile.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      window.nekko.listRepos(query.trim())
        .then((l) => { if (live) setList(l); })
        .catch((e) => { if (live) setError(String(e)); })
        .finally(() => { if (live) setLoading(false); });
    }, query ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [connected, query]);

  useEffect(() => { if (autoFocus && connected) input.current?.focus({ preventScroll: true }); }, [autoFocus, connected]);

  const shown = useMemo(() => filterRepos(list?.repos ?? [], query).slice(0, 50), [list, query]);
  if (!connected) return <ConnectRepos onConnect={onConnect} />;

  const pick = (repo: RemoteRepo) => {
    if (busy) return;
    const key = `${repo.provider}:${repo.fullName}`;
    setBusy(key);
    setError(null);
    onPick(repo)
      .catch((e) => setError(String(e).replace(/^Error:\s*/, '')))
      .finally(() => setBusy(null));
  };

  const failures = (list?.providers ?? []).filter((p) => p.error);
  return (
    <div className="flex min-h-0 flex-col" aria-busy={loading || !!busy}>
      <label className="mx-1 mb-1 flex items-center gap-2 rounded-lg border border-line px-2 py-1">
        <SearchIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repositories"
          aria-label="Search repositories" className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
      </label>
      {failures.map((p) => <p key={p.kind} role="alert" className="px-3 py-1 text-2xs text-danger">{p.error}</p>)}
      {error && <p role="alert" className="px-3 py-1 text-2xs text-danger">{error}</p>}
      <div className="min-h-0 overflow-y-auto" role="listbox" aria-label="Repositories">
        {shown.map((r) => {
          const key = `${r.provider}:${r.fullName}`;
          const added = savedClone(saved, r);
          return (
            <button key={key} type="button" role="option" aria-selected={false} disabled={!!busy && busy !== key}
              title={added ? `Already on this computer: ${added.path}` : `Clone ${r.fullName} from ${PROVIDER_LABEL[r.provider]}`}
              className="flex w-full min-w-0 items-start gap-2 rounded-lg px-3 py-1 text-left hover:bg-surface-2 disabled:opacity-50"
              onClick={() => pick(r)}>
              <span className="mt-0.5 shrink-0"><ConnectorIcon kind={r.provider} size={14} /></span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
                  <span className="min-w-0 truncate">{r.fullName}</span>
                  {r.private && <span className="shrink-0 text-2xs font-normal text-ink-faint">private</span>}
                </span>
                {r.description && <span className="truncate text-2xs text-ink-faint">{r.description}</span>}
              </span>
              <span className="shrink-0 text-2xs text-ink-faint">{busy === key ? 'Cloning…' : added ? 'On this computer' : ''}</span>
            </button>
          );
        })}
        {!shown.length && <p className="px-3 py-2 text-2xs text-ink-faint">{loading || !list ? 'Loading repositories…' : query ? `No repositories match "${query}".` : 'No repositories found.'}</p>}
      </div>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SessionSummary } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { getCachedSession, loadSession } from '../sessionCache.js';
import { hasAppChrome } from '../chrome.js';
import { FilePane } from '../components/FilePane.js';
import { ExternalIcon, FocusLayoutIcon } from '../icons.js';
import { artifactCandidates, groupArtifacts, mergeArtifacts, sessionArtifacts, type ArtifactEntry } from '../artifactsIndex.js';

/** Where a chat's relative links resolve: its checkout of the primary folder, else that folder. */
function basePathOf(session: { workspaceId?: string; gitWorktrees?: Record<string, { path?: string }> }, workspaces: Array<{ id: string; path: string }>): string | undefined {
  if (!session.workspaceId) return undefined;
  return session.gitWorktrees?.[session.workspaceId]?.path ?? workspaces.find((w) => w.id === session.workspaceId)?.path;
}

const when = (at: number) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/**
 * Everything the agents have made, in one place: docs, web pages, designs,
 * diagrams, data and office files, grouped by kind. Each item names the chat
 * it came from and opens it on the Agents wall in Focused view.
 */
export function ArtifactsView() {
  const { sessions, workspaces, refreshSessions, focusChatOnWall } = useStore(useShallow((s) => ({
    sessions: s.sessions,
    workspaces: s.settings?.workspaces ?? [],
    refreshSessions: s.refreshSessions,
    focusChatOnWall: s.focusChatOnWall,
  })));
  const [entries, setEntries] = useState<ArtifactEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ArtifactEntry | null>(null);
  const [includeCompleted, setIncludeCompleted] = useState(true);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

  // Transcripts are read a few at a time from the newest chat back; cached
  // ones paint at once. Only paths are kept, never file contents.
  const candidates = useMemo(
    () => artifactCandidates(sessions.filter((s: SessionSummary) => includeCompleted || !s.archivedAt)),
    [sessions, includeCompleted],
  );
  const key = candidates.map((s) => `${s.id}:${s.updatedAt}`).join('|');
  useEffect(() => {
    let live = true;
    (async () => {
      const lists: ArtifactEntry[][] = [];
      for (let i = 0; i < candidates.length; i += 6) {
        const batch = await Promise.all(candidates.slice(i, i + 6).map(async (summary) => {
          const cached = getCachedSession(summary.id);
          const full = cached && cached.updatedAt >= summary.updatedAt ? cached : await loadSession(summary.id).catch(() => null);
          return full ? sessionArtifacts(full, basePathOf(full, workspaces)) : [];
        }));
        if (!live) return;
        lists.push(...batch);
        setEntries(mergeArtifacts(lists));
      }
      if (live && candidates.length === 0) setEntries([]);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspaces]);

  const groups = useMemo(() => groupArtifacts(entries ?? [], query), [entries, query]);
  const total = entries?.length ?? 0;

  return (
    <div className="flex h-full min-h-0" data-artifacts-view>
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-2 p-4 pb-2">
          {!hasAppChrome && <h1 className="view-title">Artifacts</h1>}
          <span className="ml-auto text-[11px] tabular-nums text-ink-faint">{entries ? `${total} item${total === 1 ? '' : 's'}` : 'Reading chats…'}</span>
        </div>
        <div className="space-y-2 px-3 pb-2">
          <input className="input rounded-lg px-2.5 py-1.5 text-[12px]" placeholder="Filter by name, file or chat…" aria-label="Filter artifacts" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="flex items-center gap-2 text-[11px] text-ink-faint">
            <input type="checkbox" checked={includeCompleted} onChange={(e) => setIncludeCompleted(e.target.checked)} /> Include completed chats
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="list" aria-label="Artifacts">
          {entries && groups.length === 0 && (
            <p className="px-3 py-2 text-[12px] text-ink-faint">
              {query ? 'Nothing matches.' : 'No artifacts yet. Documents, pages, designs and diagrams your agents write or link to show up here.'}
            </p>
          )}
          {groups.map(({ kind, items }) => (
            <section key={kind.id} className="mb-2" data-artifact-kind={kind.id} aria-label={kind.label}>
              <h2 className="flex items-center gap-2 px-2 pb-1 pt-2 text-[12px] font-semibold text-ink">
                {kind.label}
                <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-normal tabular-nums text-ink-faint">{items.length}</span>
              </h2>
              {items.map((e) => {
                const active = selected?.path === e.path;
                return (
                  <div key={e.path} role="listitem" className={`group rounded-lg ${active ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}>
                    <button type="button" className="flex w-full min-w-0 items-start gap-2.5 px-2 py-1.5 text-left" onClick={() => setSelected(e)} title={e.path}>
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[9px] font-semibold uppercase text-ink-faint" aria-hidden>
                        {e.filename.split('.').pop()?.slice(0, 4)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-ink">{e.title}</span>
                        <span className="block truncate text-[10.5px] text-ink-faint">{e.sessionTitle} · {when(e.at)}</span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold">{selected.title}</p>
                <p className="truncate font-mono text-[10.5px] text-ink-faint" title={selected.path}>{selected.path}</p>
              </div>
              <button type="button" className="btn btn-primary gap-1.5 py-1 text-[12px]" onClick={() => focusChatOnWall(selected.sessionId)} title={`Open “${selected.sessionTitle}” on the Agents wall in Focused view`}>
                <FocusLayoutIcon className="h-3.5 w-3.5" /> Open chat
              </button>
              <button type="button" className="btn btn-outline gap-1.5 py-1 text-[12px]" onClick={() => window.nekko.openPath(selected.path)} title="Open with the system's default app">
                <ExternalIcon className="h-3.5 w-3.5" /> Open file
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden" key={selected.path}>
              <FilePane path={selected.path} />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
            <h2 className="text-lg font-semibold">What your agents made</h2>
            <p className="max-w-sm text-[13px] text-ink-faint">
              Reports, pages, designs and diagrams from every chat, grouped by kind. Pick one to preview it, or open the chat it came from in Focused view.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

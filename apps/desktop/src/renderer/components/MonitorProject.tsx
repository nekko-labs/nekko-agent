import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectorConfig, ConnectorKind, ConnectorResource } from '@nekko-agent/shared';
import { CONNECTOR_CATALOG, isTaskConnector, parseTasksMarkdown, pickProjectTaskFile } from '@nekko-agent/shared';
import { ConnectorIcon } from '../connectorIcons.js';
import { useStore } from '../store.js';

type Loaded = { items: ConnectorResource[] } | { error: string };

/** The connected task systems (Linear, Jira, Trello, Asana, Todoist, ClickUp, a tasks file), in catalog order. */
export function connectedTaskSources(connectors: ConnectorConfig[] | undefined): ConnectorKind[] {
  const on = new Set((connectors ?? []).filter((c) => c.connected && isTaskConnector(c.kind)).map((c) => c.kind));
  return CONNECTOR_CATALOG.filter((c) => on.has(c.kind)).map((c) => c.kind);
}

/** What a task hands to the agent: title, where it came from, link and notes. */
export function taskPrompt(source: ConnectorKind | string, task: ConnectorResource): string {
  const label = CONNECTOR_CATALOG.find((c) => c.kind === source)?.label ?? source;
  return [`Work on this ${label} task: ${task.title}`, task.url && `Link: ${task.url}`, task.body?.trim() && `Details:\n${task.body.trim().slice(0, 2000)}`]
    .filter(Boolean).join('\n');
}

/** The file name at the end of a path, either separator. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The repo-based fallback: the chat's own project folder's task file
 * (TASKS.md, TODO.md, ...), read through the same file bridge the viewer uses.
 * `null` while there is no folder, `undefined` while loading.
 */
export function useProjectTaskFile(projectPath: string | undefined, enabled: boolean) {
  const [state, setState] = useState<{ path: string; items: ConnectorResource[] } | { error: string } | null | undefined>(() => (projectPath && enabled ? undefined : null));
  const load = useCallback(async () => {
    if (!projectPath || !enabled) { setState(null); return; }
    setState(undefined);
    try {
      const entries = await window.nekko.listDir(projectPath);
      const name = pickProjectTaskFile(entries.filter((e) => !e.dir).map((e) => e.name));
      const entry = name ? entries.find((e) => e.name === name) : undefined;
      if (!entry) { setState(null); return; }
      const file = await window.nekko.readFile(entry.path);
      setState(file.binary ? null : { path: entry.path, items: parseTasksMarkdown(file.content, entry.path) });
    } catch (e) {
      setState({ error: (e as Error).message || 'Could not read the project task file.' });
    }
  }, [projectPath, enabled]);
  useEffect(() => { void load(); }, [load]);
  return { file: state, reload: load };
}

/**
 * The Agent Monitor's Project group: the work this chat's project tracks.
 *
 * Connected project-management connectors (Linear, Jira, Asana, Trello,
 * Todoist, ClickUp, a picked tasks file) come first, one tab per source.
 * Without one, it falls back to the repo itself: a TASKS.md (or TODO.md,
 * BACKLOG.md, ROADMAP.md) at the root of the chat's project folder. With
 * neither it says how to get one. Clicking a task drops it into this chat's
 * composer, so nothing is sent without the user pressing Send.
 */
export function MonitorProject({ sessionId, projectPath }: { sessionId: string; projectPath?: string }) {
  const connectors = useStore((s) => s.settings?.connectors);
  const sources = useMemo(() => connectedTaskSources(connectors), [connectors]);
  const [active, setActive] = useState<ConnectorKind | null>(null);
  const [loaded, setLoaded] = useState<Partial<Record<ConnectorKind, Loaded>>>({});
  const [busy, setBusy] = useState(false);
  const current = active && sources.includes(active) ? active : sources[0] ?? null;
  const { file, reload } = useProjectTaskFile(projectPath, sources.length === 0);

  const load = useCallback(async (kind: ConnectorKind) => {
    setBusy(true);
    try {
      const items = await window.nekko.fetchConnector(kind);
      setLoaded((l) => ({ ...l, [kind]: { items } }));
    } catch (e) {
      setLoaded((l) => ({ ...l, [kind]: { error: (e as Error).message || 'Could not load tasks.' } }));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (current && !loaded[current]) void load(current);
  }, [current, loaded, load]);

  const fileSource = !current && file && 'path' in file ? file : null;
  const data: Loaded | undefined = current ? loaded[current]
    : fileSource ? { items: fileSource.items }
    : file && 'error' in file ? file : undefined;
  const sourceLabel = current ? CONNECTOR_CATALOG.find((c) => c.kind === current)?.label ?? current
    : fileSource ? baseName(fileSource.path) : null;
  const none = !current && file === null;
  const seed = (t: ConnectorResource) => useStore.getState().seedComposer(sessionId, taskPrompt(current ?? baseName(fileSource?.path ?? 'project'), t), []);

  return (
    <details open className="group rounded-lg p-2" data-monitor-project data-project-source={current ?? (fileSource ? 'repo' : 'none')}>
      <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-ink-soft">
        <span className="flex-1">Project{data && 'items' in data && <span className="ml-1 tabular-nums">{data.items.length}</span>}</span>
        {(current || fileSource) && <button type="button" className="rounded px-1 text-2xs normal-case tracking-normal hover:bg-surface-2 disabled:opacity-50" disabled={busy}
          onClick={(e) => { e.preventDefault(); if (current) void load(current); else void reload(); }} title="Reload tasks">{busy ? 'Loading…' : 'Refresh'}</button>}
      </summary>
      {sourceLabel && sources.length <= 1 && <p className="mt-1 flex items-center gap-2 text-2xs text-ink-faint" data-project-label>
        {current ? <ConnectorIcon kind={current} size={12} /> : <span aria-hidden className="font-mono">#</span>}
        {fileSource
          ? <button type="button" className="truncate hover:text-ink hover:underline" title={`Open ${fileSource.path}`} onClick={() => useStore.getState().openFilePane(fileSource.path, sessionId)}>{sourceLabel}</button>
          : <span className="truncate">{sourceLabel}</span>}
        {fileSource && <span className="shrink-0">· in this repo</span>}
      </p>}
      {sources.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-1" role="tablist" aria-label="Project sources">
          {sources.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={k === current} title={CONNECTOR_CATALOG.find((c) => c.kind === k)?.label}
              className="grid h-6 w-6 place-items-center rounded-md hover:bg-surface-2"
              style={k === current ? { background: 'var(--surface-2)', boxShadow: 'inset 0 0 0 1px var(--line)' } : undefined}
              onClick={() => setActive(k)}><ConnectorIcon kind={k} size={14} /></button>
          ))}
        </div>
      )}
      <div className="mt-1">
        {none ? <p className="text-2xs leading-snug text-ink-faint">
            No project tracker yet. <button type="button" className="underline hover:text-ink" onClick={() => useStore.getState().setView('connectors')}>Connect Linear, Jira or Asana</button>{projectPath ? ', or add a TASKS.md to this repo.' : '.'}
          </p>
          : !data ? <p className="text-2xs text-ink-faint">Loading tasks…</p>
          : 'error' in data ? <p className="text-2xs" style={{ color: 'var(--danger)' }}>{data.error}</p>
          : data.items.length === 0 ? <p className="text-2xs text-ink-faint">No open tasks.</p>
          : <ul className="max-h-64 space-y-0.5 overflow-y-auto">{data.items.slice(0, 50).map((t) => (
            <li key={t.id}>
              <button type="button" className="flex w-full items-start gap-2 rounded-lg px-1 py-1 text-left hover:bg-surface-2"
                title="Add this task to the message box"
                onClick={() => seed(t)}>
                <span className="mt-1 block h-2.5 w-2.5 shrink-0 rounded-[3px] border" style={{ borderColor: 'var(--ink-faint)' }} />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-xs leading-snug text-ink-soft">{t.title}</span>
                  {t.subtitle && <span className="block truncate text-2xs text-ink-faint">{t.subtitle}</span>}
                </span>
              </button>
            </li>
          ))}</ul>}
      </div>
    </details>
  );
}

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectorConfig, ConnectorKind, ConnectorResource } from '@nekko-agent/shared';
import { CONNECTOR_CATALOG, isTaskConnector } from '@nekko-agent/shared';
import { ConnectorIcon } from '../connectorIcons.js';
import { useStore } from '../store.js';

type Loaded = { items: ConnectorResource[] } | { error: string };

/** The connected task systems (Linear, Jira, Trello, Asana, Todoist, ClickUp, a tasks file), in catalog order. */
export function connectedTaskSources(connectors: ConnectorConfig[] | undefined): ConnectorKind[] {
  const on = new Set((connectors ?? []).filter((c) => c.connected && isTaskConnector(c.kind)).map((c) => c.kind));
  return CONNECTOR_CATALOG.filter((c) => on.has(c.kind)).map((c) => c.kind);
}

/** What a task hands to the agent: title, where it came from, link and notes. */
export function taskPrompt(kind: ConnectorKind, task: ConnectorResource): string {
  const label = CONNECTOR_CATALOG.find((c) => c.kind === kind)?.label ?? kind;
  return [`Work on this ${label} task: ${task.title}`, task.url && `Link: ${task.url}`, task.body?.trim() && `Details:\n${task.body.trim().slice(0, 2000)}`]
    .filter(Boolean).join('\n');
}

/**
 * The user's task system inside the Agent Monitor. It only appears once a task
 * connector is connected (Settings → Connectors), shows one tab per source and
 * lists open items; clicking one drops it into this chat's composer, so nothing
 * is sent without the user pressing Send.
 */
export function MonitorTasks({ sessionId }: { sessionId: string }) {
  const connectors = useStore((s) => s.settings?.connectors);
  const sources = useMemo(() => connectedTaskSources(connectors), [connectors]);
  const [active, setActive] = useState<ConnectorKind | null>(null);
  const [loaded, setLoaded] = useState<Partial<Record<ConnectorKind, Loaded>>>({});
  const [busy, setBusy] = useState(false);
  const current = active && sources.includes(active) ? active : sources[0] ?? null;

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

  if (!sources.length) return null;
  const data = current ? loaded[current] : undefined;

  return (
    <details open className="group rounded-lg p-2" data-monitor-tasks>
      <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        <span className="flex-1">Tasks{data && 'items' in data && <span className="ml-1 tabular-nums">{data.items.length}</span>}</span>
        {current && <button type="button" className="rounded px-1 text-[10px] normal-case tracking-normal hover:bg-surface-2 disabled:opacity-50" disabled={busy} onClick={(e) => { e.preventDefault(); void load(current); }} title="Reload tasks">{busy ? 'Loading…' : 'Refresh'}</button>}
      </summary>
      {sources.length > 1 && (
        <div className="mt-1.5 flex flex-wrap gap-1" role="tablist" aria-label="Task sources">
          {sources.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={k === current} title={CONNECTOR_CATALOG.find((c) => c.kind === k)?.label}
              className="grid h-6 w-6 place-items-center rounded-md hover:bg-surface-2"
              style={k === current ? { background: 'var(--surface-2)', boxShadow: 'inset 0 0 0 1px var(--line)' } : undefined}
              onClick={() => setActive(k)}><ConnectorIcon kind={k} size={14} /></button>
          ))}
        </div>
      )}
      <div className="mt-1.5">
        {!data ? <p className="text-[11px] text-ink-faint">Loading tasks…</p>
          : 'error' in data ? <p className="text-[11px]" style={{ color: 'var(--danger)' }}>{data.error}</p>
          : data.items.length === 0 ? <p className="text-[11px] text-ink-faint">No open tasks.</p>
          : <ul className="max-h-64 space-y-0.5 overflow-y-auto">{data.items.slice(0, 50).map((t) => (
            <li key={t.id}>
              <button type="button" className="flex w-full items-start gap-1.5 rounded-lg px-1 py-1 text-left hover:bg-surface-2"
                title="Add this task to the message box"
                onClick={() => current && useStore.getState().seedComposer(sessionId, taskPrompt(current, t), [])}>
                <span className="mt-[5px] block h-2.5 w-2.5 shrink-0 rounded-[3px] border" style={{ borderColor: 'var(--ink-faint)' }} />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[12px] leading-snug text-ink-soft">{t.title}</span>
                  {t.subtitle && <span className="block truncate text-[10px] text-ink-faint">{t.subtitle}</span>}
                </span>
              </button>
            </li>
          ))}</ul>}
      </div>
    </details>
  );
}

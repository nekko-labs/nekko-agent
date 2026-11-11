import React, { useEffect, useState } from 'react';
import type { ConnectorKind, RemoteRepoList, RepoExclusions } from '@nekko-agent/shared';
import { ChevronIcon } from '../icons.js';
import { groupRepos, withChoice } from '../connectorRepos.js';

/**
 * A connected GitHub or GitLab row's repositories (#2562): one disclosure,
 * closed by default with a count, holding the repositories grouped under
 * their owner. Remove takes a repository, or a whole org, out of Add
 * repository and chat context; Removed lists them again with Add back.
 */
export function ConnectorRepos({
  kind,
  exclusions,
  onChange,
}: {
  kind: ConnectorKind;
  exclusions: RepoExclusions;
  onChange: (next: RepoExclusions) => void;
}) {
  const [list, setList] = useState<RemoteRepoList | string | null>(null);

  useEffect(() => {
    let live = true;
    window.nekko
      .connectorRepos(kind)
      .then((l) => live && setList(l))
      .catch((e) => live && setList((e as Error).message || 'Could not list repositories.'));
    return () => {
      live = false;
    };
  }, [kind]);

  if (list === null) return null;
  return <RepoChoice kind={kind} list={list} exclusions={exclusions} onChange={onChange} />;
}

/** The disclosure itself, for a loaded list (or the error that stopped it). */
export function RepoChoice({
  kind,
  list,
  exclusions,
  onChange,
  startOpen = false,
}: {
  kind: ConnectorKind;
  list: RemoteRepoList | string;
  exclusions: RepoExclusions;
  onChange: (next: RepoExclusions) => void;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const error = typeof list === 'string' ? list : list.providers.find((p) => p.error)?.error;
  const view = groupRepos(typeof list === 'string' ? [] : list.repos, exclusions);
  const removedCount = view.removedOwners.length + view.removedRepos.length;
  // One owner needs no second click.
  const groupOpen = (key: string) => openGroups[key] ?? view.groups.length === 1;
  const toggleGroup = (key: string) => setOpenGroups((g) => ({ ...g, [key]: !groupOpen(key) }));
  const set = (key: keyof RepoExclusions, name: string, remove: boolean) => onChange(withChoice(exclusions, key, name, remove));

  return (
    <div className="pb-2" style={{ paddingLeft: 48 }} data-connector-repos={kind}>
      <Disclosure open={open} onToggle={() => setOpen(!open)} label="Repositories" meta={view.kept === view.total ? `${view.total}` : `${view.kept} of ${view.total}`} strong />
      <div className={`collapse-wrap ${open ? '' : 'collapsed'}`} aria-hidden={!open}>
        <div className="min-h-0 overflow-hidden">
          {open && (
            <div className="flex flex-col fade-in" style={{ paddingLeft: 20, gap: 'var(--q-inline)' }}>
              {error && (
                <p className="text-2xs" style={{ color: 'var(--danger-text)' }} role="alert">
                  {error}
                </p>
              )}
              {!error && view.total === 0 && <p className="text-xs text-ink-faint">No repositories reachable with this token.</p>}
              {view.groups.map((g) => {
                const key = g.owner.toLowerCase();
                const gOpen = groupOpen(key);
                return (
                  <div key={key} data-repo-group={g.owner}>
                    <Disclosure
                      open={gOpen}
                      onToggle={() => toggleGroup(key)}
                      label={g.owner}
                      meta={`${g.repos.length}`}
                      action={<RowAction label={`Remove ${g.owner}`} text="Remove org" onClick={() => set('excludedOwners', g.owner, true)} />}
                    />
                    <div className={`collapse-wrap ${gOpen ? '' : 'collapsed'}`} aria-hidden={!gOpen}>
                      <ul className="min-h-0 overflow-hidden" style={{ paddingLeft: 20 }}>
                        {gOpen &&
                          g.repos.map((r) => (
                            <RepoLine key={r.fullName} name={r.fullName.slice(g.owner.length + 1)} detail={r.private ? 'private' : undefined}>
                              <RowAction label={`Remove ${r.fullName}`} text="Remove" onClick={() => set('excludedRepos', r.fullName, true)} />
                            </RepoLine>
                          ))}
                      </ul>
                    </div>
                  </div>
                );
              })}
              {removedCount > 0 && (
                <RemovedGroup count={removedCount}>
                  {view.removedOwners.map((o) => (
                    <RepoLine key={`o:${o.owner}`} name={o.owner} detail={o.count === 1 ? 'org, 1 repository' : `org, ${o.count} repositories`}>
                      <RowAction label={`Add back ${o.owner}`} text="Add back" onClick={() => set('excludedOwners', o.owner, false)} />
                    </RepoLine>
                  ))}
                  {view.removedRepos.map((r) => (
                    <RepoLine key={r.fullName} name={r.fullName}>
                      <RowAction label={`Add back ${r.fullName}`} text="Add back" onClick={() => set('excludedRepos', r.fullName, false)} />
                    </RepoLine>
                  ))}
                </RemovedGroup>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Disclosure({ open, onToggle, label, meta, action, strong = false }: { open: boolean; onToggle: () => void; label: string; meta: string; action?: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2" data-quiet-row>
      <button type="button" className="flex min-w-0 items-center gap-2 py-1 text-left text-xs" aria-expanded={open} onClick={onToggle}>
        <ChevronIcon className={`h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        <span className={`truncate font-medium ${strong ? '' : 'text-ink-soft'}`}>{label}</span>
        <span className="shrink-0 tabular-nums text-ink-faint">{meta}</span>
      </button>
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  );
}

function RemovedGroup({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-repo-group="removed">
      <Disclosure open={open} onToggle={() => setOpen(!open)} label="Removed" meta={`${count}`} />
      <div className={`collapse-wrap ${open ? '' : 'collapsed'}`} aria-hidden={!open}>
        <ul className="min-h-0 overflow-hidden" style={{ paddingLeft: 20 }}>
          {open && children}
        </ul>
      </div>
    </div>
  );
}

function RepoLine({ name, detail, children }: { name: string; detail?: string; children: React.ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-2 fade-in" style={{ minHeight: 28 }} data-quiet-row>
      <span className="min-w-0 truncate text-xs" title={name}>
        {name}
      </span>
      {detail && <span className="shrink-0 text-2xs text-ink-faint">{detail}</span>}
      <span className="ml-auto shrink-0">{children}</span>
    </li>
  );
}

/** Faint until the row is hovered or focused; always there on touch. */
function RowAction({ label, text, onClick }: { label: string; text: string; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-ghost quiet-row-action py-1 text-2xs" aria-label={label} onClick={onClick}>
      {text}
    </button>
  );
}

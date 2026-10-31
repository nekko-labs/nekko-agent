import React, { useEffect, useState } from 'react';
import type { SpecDocStatus, SessionMeta } from '@nekko-agent/shared';
import { DEFAULT_SPEC_METHODOLOGY, SPEC_METHODOLOGIES, getMethodology, getSessionWorkspaceIds, parseTasks } from '@nekko-agent/shared';
import { ExternalIcon } from '../icons.js';
import { useStore } from '../store.js';

/**
 * Spec-driven development panel (Kiro-inspired). Pick a methodology, then build
 * or update each artifact in order, the spec, then a task checklist.
 * Later artifacts are chained from the earlier ones server-side. The tasks doc
 * renders as an interactive checklist whose toggles write back to the file.
 */
export function SpecPanel(props: { sessionId: string; session: SessionMeta | null }) {
  return props.session?.executionMode === 'sandbox' ? <p className="p-3 text-sm text-ink-soft">Host spec actions are unavailable in Sandbox.</p> : <HostSpecPanel {...props} />;
}
function HostSpecPanel({ sessionId, session }: { sessionId: string; session: SessionMeta | null }) {
  const refreshSessions = useStore((s) => s.refreshSessions);
  const pushToast = useStore((s) => s.pushToast);
  const settings = useStore((s) => s.settings);

  const [docs, setDocs] = useState<SpecDocStatus[] | null>(null);
  const [methodologyId, setMethodologyId] = useState<string>(DEFAULT_SPEC_METHODOLOGY);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(session?.workspaceId);
  const [busy, setBusy] = useState<string | null>(null); // doc id (or 'all') currently building
  const [showTasks, setShowTasks] = useState(true);

  const workspaceIds = session ? getSessionWorkspaceIds(session) : [];
  const workspaceKey = workspaceIds.join(',');
  const primaryWorkspaceId = session?.workspaceId;
  const selectedWorkspaceId = workspaceIds.includes(workspaceId ?? '') ? workspaceId : workspaceIds[0];
  const hasWorkspace = workspaceIds.length > 0;

  const refresh = (targetWorkspaceId = selectedWorkspaceId) => {
    window.nekko.readSpecDocs(sessionId, targetWorkspaceId).then((r) => {
      setDocs(r.docs);
      setMethodologyId(r.methodologyId);
    });
  };

  // Follow the folder picked in the Folders section above: whenever the primary
  // changes (or the set of folders does), snap to it. Keeping a stale pick here
  // meant the panel showed one project's spec while the pane above said another
  // was primary. The select below still overrides, until the choice above moves.
  useEffect(() => {
    setWorkspaceId(primaryWorkspaceId ?? workspaceIds[0]);
  }, [primaryWorkspaceId, workspaceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sessionId) return;
    refresh(selectedWorkspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, selectedWorkspaceId, session?.specMethodology, workspaceKey]);

  // Open the doc in the built-in viewer pane (not the OS, which silently fails
  // when nothing is registered for .md and never kept you in the app anyway).
  const openFilePane = useStore.getState().openFilePane;
  const open = (target: string) => openFilePane(target);

  const changeMethodology = async (id: string) => {
    setMethodologyId(id);
    await window.nekko.setSpecMethodology(sessionId, id);
    await refreshSessions();
    refresh(selectedWorkspaceId);
  };

  const build = async (docId: string) => {
    setBusy(docId);
    const res = await window.nekko.buildSpecDoc(sessionId, docId, selectedWorkspaceId);
    setBusy(null);
    if (res.ok) {
      const label = methodology.docs.find((d) => d.id === docId)?.label ?? 'Document';
      pushToast('success', `${label} updated from this chat.`);
      refresh(selectedWorkspaceId);
    } else {
      pushToast('error', res.message ?? 'Could not build the document.');
    }
  };

  const buildAll = async () => {
    setBusy('all');
    let failed: string | null = null;
    for (const d of methodology.docs) {
      const res = await window.nekko.buildSpecDoc(sessionId, d.id, selectedWorkspaceId);
      if (!res.ok) {
        failed = res.message ?? `Could not build ${d.label}.`;
        break;
      }
    }
    setBusy(null);
    refresh(selectedWorkspaceId);
    if (failed) pushToast('error', failed);
    else pushToast('success', `Built ${methodology.docs.length} artifacts from this chat.`);
  };

  const toggleLive = async () => {
    await window.nekko.setSpecLinked(sessionId, !session?.specLinked);
    await refreshSessions();
  };

  const toggleTask = async (line: number) => {
    const res = await window.nekko.toggleSpecTask(sessionId, line, selectedWorkspaceId);
    if (res.ok) refresh(selectedWorkspaceId);
    else pushToast('error', res.message ?? 'Could not update the task.');
  };

  const methodology = getMethodology(methodologyId);
  const selectedWorkspacePath = settings?.workspaces?.find((w) => w.id === selectedWorkspaceId)?.path;
  const tasksDoc = docs?.find((d) => d.role === 'tasks');
  const tasks = tasksDoc?.exists ? parseTasks(tasksDoc.content) : [];
  const doneCount = tasks.filter((t) => t.done).length;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">Spec-driven dev</span>
        {docs && docs.some((d) => d.exists) && (
          <button
            className={`text-2xs uppercase tracking-wide ${session?.specLinked ? 'text-accent' : 'text-ink-faint hover:text-ink'}`}
            title="Rebuild the spec after every reply"
            onClick={toggleLive}
          >
            {session?.specLinked ? '● Live' : '○ Live'}
          </button>
        )}
      </div>

      {!hasWorkspace && (
        <p className="px-1 text-2xs leading-snug text-ink-faint">
          Add a project folder to this chat, then build a spec and tasks straight from the conversation.
        </p>
      )}

      {hasWorkspace && (
        <>
          {workspaceIds.length > 1 && (
            <select
              className="input mb-2 w-full text-xs"
              value={selectedWorkspaceId ?? ''}
              onChange={(e) => setWorkspaceId(e.target.value)}
              title="Select the project whose spec and tasks are shown"
            >
              {workspaceIds.map((id) => (
                <option key={id} value={id}>
                  {session?.workspaceId === id ? 'Primary · ' : 'Supporting · '}
                  {baseName(settings?.workspaces?.find((w) => w.id === id)?.path ?? id)}
                </option>
              ))}
            </select>
          )}
          {/* Methodology picker */}
          <select
            className="input mb-2 w-full text-xs"
            value={methodologyId}
            onChange={(e) => changeMethodology(e.target.value)}
            title={methodology.description}
          >
            {SPEC_METHODOLOGIES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          {/* Artifact rows. The name is always a link: a doc that exists opens
              in the file pane, and one that doesn't says so rather than being a
              dead control you can't tell apart from a live one. */}
          <div className="space-y-1">
            {(docs ?? methodology.docs.map((d) => ({ ...d, path: '', exists: false, content: '' }))).map((d) => (
              <div
                key={d.id}
                className={`rounded-lg border px-3 py-2 ${d.exists ? 'border-accent/40 bg-accent/5' : 'border-line'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    className="group flex min-w-0 items-center gap-2 text-left"
                    onClick={() => (d.exists ? open(d.path) : build(d.id))}
                    disabled={!d.exists && !!busy}
                    title={d.exists ? `Open ${d.path}` : `Not created yet — click to write ${d.filename} from this chat`}
                  >
                    <span className="truncate text-xs font-medium">{d.label}</span>
                    <span className="chip shrink-0 text-2xs lowercase">{d.filename}</span>
                    {d.exists
                      ? <ExternalIcon className="h-3 w-3 shrink-0 text-ink-faint opacity-0 group-hover:opacity-100" />
                      : <span className="shrink-0 text-2xs text-ink-faint">not created</span>}
                  </button>
                  <button
                    className="btn btn-outline shrink-0 text-2xs"
                    onClick={() => build(d.id)}
                    disabled={!!busy}
                    title={d.exists ? `Rewrite ${d.filename} from this conversation` : `Write ${d.filename} from this conversation`}
                  >
                    {busy === d.id ? (d.exists ? 'Updating…' : 'Creating…') : d.exists ? 'Update' : 'Create'}
                  </button>
                </div>
                <p className="mt-0.5 text-2xs leading-snug text-ink-faint">{d.description}</p>
              </div>
            ))}
          </div>

          {methodology.docs.length > 1 && (
            <button
              className="btn btn-outline mt-2 w-full text-xs"
              onClick={buildAll}
              disabled={!!busy}
              title={`Write every ${methodology.label} document for this project from the conversation`}
            >
              {busy === 'all' ? 'Setting up…' : 'Set up this project'}
            </button>
          )}

          {/* Guideline files. Not generated from the chat like the spec docs are:
              AGENTS.md is a standing instruction to every agent, so a missing one
              gets a starter you then edit, opened in the file pane. */}
          <GuidelineDocs workspacePath={selectedWorkspacePath} onOpen={open} />


          {/* Tasks checklist */}
          {tasks.length > 0 && (
            <div className="mt-3">
              <button
                className="mb-1 flex w-full items-center justify-between text-2xs font-semibold uppercase tracking-wide text-ink-faint"
                onClick={() => setShowTasks((v) => !v)}
              >
                <span>Tasks · {doneCount}/{tasks.length}</span>
                <span>{showTasks ? '▾' : '▸'}</span>
              </button>
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${tasks.length ? (doneCount / tasks.length) * 100 : 0}%`, background: 'var(--accent)' }}
                />
              </div>
              {showTasks && (
                <div className="space-y-0.5">
                  {tasks.map((t) => (
                    <label
                      key={t.line}
                      className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 hover:bg-surface-2"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 shrink-0 accent-(--accent)"
                        checked={t.done}
                        onChange={() => toggleTask(t.line)}
                      />
                      <span className={`text-xs leading-snug ${t.done ? 'text-ink-faint line-through' : ''}`}>
                        {t.text}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Guideline files: the standing instructions every chat in this project carries,
 * whether or not they were written here.
 *
 * `AGENTS.md` and `CLAUDE.md` are always listed, present or not. They aren't
 * generated from the conversation the way a spec is — a guideline is a rule you
 * decide, not a summary of what was said — so a missing one gets a short starter
 * and opens in the editor for you to write. Other guideline conventions only
 * appear once they exist, so the list stays short.
 */
const GUIDELINE_DOCS: Array<{ filename: string; description: string; always: boolean; starter: (project: string) => string }> = [
  {
    filename: 'AGENTS.md',
    description: 'How any agent should work in this project.',
    always: true,
    starter: (project) => `# Agent workflow

Conventions for any AI agent or human working in ${project}.

## How to work here

- (How should changes be proposed: direct commits, branches, pull requests?)
- (What has to pass before something is done: tests, typecheck, lint?)
- (What should never be touched without asking?)

## Conventions

- (Naming, formatting, comment style, anything a newcomer would get wrong.)
`,
  },
  {
    filename: 'CLAUDE.md',
    description: 'Claude Code reads this by default.',
    always: true,
    starter: () => `# Claude

See [AGENTS.md](AGENTS.md) for all guidance. This file exists only because Claude
Code reads \`CLAUDE.md\` by default.

Treat \`AGENTS.md\` and \`CLAUDE.md\` as the same file: put guidance in \`AGENTS.md\`
rather than duplicating it here.
`,
  },
  { filename: 'GEMINI.md', description: 'Gemini CLI guidelines.', always: false, starter: () => '' },
  { filename: '.cursorrules', description: 'Cursor rules.', always: false, starter: () => '' },
  { filename: '.windsurfrules', description: 'Windsurf rules.', always: false, starter: () => '' },
];

function GuidelineDocs({ workspacePath, onOpen }: { workspacePath?: string; onOpen: (path: string) => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [present, setPresent] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => {
    if (!workspacePath) { setPresent(null); return; }
    window.nekko.listDir(workspacePath)
      .then((entries) => setPresent(new Set(entries.filter((e) => !e.dir).map((e) => e.name))))
      .catch(() => setPresent(new Set()));
  };

  useEffect(refresh, [workspacePath]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!workspacePath) return null;

  const join = (name: string) => `${workspacePath.replace(/[\\/]+$/, '')}/${name}`;
  const rows = GUIDELINE_DOCS.filter((g) => g.always && present && !present.has(g.filename));

  const create = async (g: (typeof GUIDELINE_DOCS)[number]) => {
    const path = join(g.filename);
    setBusy(g.filename);
    try {
      await window.nekko.writeFile(path, g.starter(baseName(workspacePath)));
      refresh();
      onOpen(path);
    } catch (e) {
      pushToast('error', `Could not create ${g.filename}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  if (!rows.length) return null;

  return (
    <div className="mt-3">
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">Create missing instructions</p>
      <div className="space-y-1">
        {rows.map((g) => {
          const exists = present?.has(g.filename) ?? false;
          const path = join(g.filename);
          return (
            <div
              key={g.filename}
              className={`rounded-lg border px-3 py-2 ${exists ? 'border-accent/40 bg-accent/5' : 'border-line'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  className="group flex min-w-0 items-center gap-2 text-left"
                  onClick={() => (exists ? onOpen(path) : create(g))}
                  disabled={!exists && !!busy}
                  title={exists ? `Open ${path}` : `Not created yet — click to start ${g.filename}`}
                >
                  <span className="truncate text-xs font-medium">{g.filename}</span>
                  {exists
                    ? <ExternalIcon className="h-3 w-3 shrink-0 text-ink-faint opacity-0 group-hover:opacity-100" />
                    : <span className="shrink-0 text-2xs text-ink-faint">not created</span>}
                </button>
                {!exists && (
                  <button
                    className="btn btn-outline shrink-0 text-2xs"
                    onClick={() => create(g)}
                    disabled={!!busy}
                    title={`Write a starter ${g.filename} and open it`}
                  >
                    {busy === g.filename ? 'Creating…' : 'Create'}
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-2xs leading-snug text-ink-faint">{g.description}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import type {
  SkillDef,
  Workflow,
  WorkflowFilter,
  WorkflowGrouping,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowTemplate,
  WorkflowTriggerKind,
  WorkflowsSnapshot,
} from '@nekko-agent/shared';
import {
  UNCATEGORIZED,
  WORKFLOW_TRIGGER_KINDS,
  cliCommand,
  filterWorkflows,
  formatDuration,
  groupWorkflows,
  listenerKeys,
  listenerLabel,
  runDurationMs,
  runOutcome,
  runPolicyNote,
  stepSummary,
  triggerLabel,
} from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { Badge, EmptyHint, StatusDot, Toggle } from '../components/primitives/index.js';
import { WorkflowCanvas } from '../components/WorkflowCanvas.js';
import { WorkflowEditor, type WorkflowSeed } from '../components/WorkflowEditor.js';
import { TemplateGallery, TemplateSetup, templateSeed } from '../components/TemplateGallery.js';
import { FirstWorkflowWizard } from '../components/FirstWorkflowWizard.js';
import { setAutomationsPaused } from '../automationsPause.js';
import { PlusIcon } from '../icons.js';
import { STATUS } from '../tokens.js';
import { hasAppChrome } from '../chrome.js';
import { CiRunnersView } from './CiRunnersView.js';

/**
 * The Workflows tab: automation modelled on GitHub Actions, where a step can be
 * an agent prompt, a skill, another workflow, or a shell command.
 *
 * Built for an install that accumulates hundreds of these. The left rail filters
 * (search, state, trigger kind, category) and the list is grouped either by
 * category ("what do I have?") or by event listener ("what happens when a PR
 * opens?"), because those are the two ways a long list actually gets navigated.
 * A row expands into the step canvas and that workflow's run history, so the
 * shape of a workflow and how it last behaved are one click from the list.
 */

const STATUS_TONE: Record<WorkflowRunStatus, { color: string; label: string }> = {
  queued: { color: STATUS.neutral, label: 'queued' },
  running: { color: STATUS.running, label: 'running' },
  success: { color: STATUS.success, label: 'passed' },
  failure: { color: STATUS.danger, label: 'failed' },
  cancelled: { color: STATUS.neutral, label: 'cancelled' },
};

/** Rows drawn per group before the "show all" toggle, so hundreds stay fast. */
const ROWS_PER_GROUP = 12;

/**
 * Trigger kinds grouped by who or what sets a run off, so the filter reads in
 * plain terms instead of a flat list of kinds.
 */
const TRIGGER_FAMILIES: Array<{ label: string; kinds: WorkflowTriggerKind[] }> = [
  { label: 'You start it', kinds: ['manual', 'cli'] },
  { label: 'On a schedule', kinds: ['schedule'] },
  { label: 'On an event', kinds: ['git', 'slack', 'connector', 'webhook'] },
];

/**
 * Runs fired by an external event - a git trigger, a connector poll, or an
 * inbound webhook - rather than by hand, a schedule, or the CLI. These are the
 * CI-style runs, and they get a "runner" badge so they stand apart in the
 * history. The triggerLabel itself ("GitHub · push · owner/repo") already says
 * what fired it; the badge just marks the flavor.
 */
const isRunnerRun = (r: WorkflowRun): boolean =>
  r.triggerKind === 'git' || r.triggerKind === 'connector' || r.triggerKind === 'webhook';

export function WorkflowsView() {
  const pushToast = useStore((s) => s.pushToast);
  const installedSkills = useStore((s) => s.installedSkillDefs);
  /** What a skill step can run: built-in, installs, other tools' and Claude Code plugins' (read when the editor or a template opens). */
  const [skillDefs, setSkillDefs] = useState<SkillDef[] | null>(null);
  const skills = skillDefs ?? installedSkills;
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [snapshot, setSnapshot] = useState<WorkflowsSnapshot>({ workflows: [], runs: [] });
  const [filter, setFilter] = useState<WorkflowFilter>({});
  const [grouping, setGrouping] = useState<WorkflowGrouping>('category');
  const [section, setSection] = useState<'workflows' | 'ciRunners'>('workflows');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [creating, setCreating] = useState<{ seed?: WorkflowSeed } | null>(null);
  const [picking, setPicking] = useState(false);
  const [setup, setSetup] = useState<WorkflowTemplate | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const paused = useStore((s) => s.settings?.automationsPaused === true);
  const workflowFocus = useStore((s) => s.workflowFocus);
  /** A run a notification asked to show; its row opens on that run. */
  const [focusRun, setFocusRun] = useState<{ workflowId: string; runId: string } | null>(null);

  useEffect(() => {
    void window.nekko.listWorkflows().then((next) => { setSnapshot(next); setLoaded(true); }).catch(() => setLoadFailed(true));
    return window.nekko.onWorkflowsUpdated((next) => { setSnapshot(next); setLoaded(true); });
  }, []);

  // Re-read each time a sheet opens: a plugin enabled meanwhile shows up.
  const sheetOpen = !!(creating || editing || setup);
  useEffect(() => {
    if (!sheetOpen) return;
    void window.nekko.listWorkflowSkillDefs?.().then(setSkillDefs).catch(() => {});
  }, [sheetOpen]);

  useEffect(() => {
    if (!workflowFocus) return;
    setFocusRun(workflowFocus);
    setExpanded(workflowFocus.workflowId);
    setFilter({});
    useStore.setState({ workflowFocus: null });
  }, [workflowFocus]);

  // Scroll once, when the row exists (the snapshot may still be loading), then let go.
  useEffect(() => {
    if (!focusRun) return;
    const row = document.querySelector(`[data-workflow-row="${CSS.escape(focusRun.workflowId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    setFocusRun(null);
  }, [focusRun, snapshot]);

  const togglePaused = async (next: boolean) => {
    try {
      await setAutomationsPaused(next);
      pushToast('info', next ? 'Automations paused. Running ones were stopped.' : 'Automations resumed.');
    } catch (e) {
      pushToast('error', `Could not ${next ? 'pause' : 'resume'} automations: ${(e as Error).message}`);
    }
  };

  const { workflows, runs } = snapshot;
  const visible = useMemo(() => filterWorkflows(workflows, filter), [workflows, filter]);
  const groups = useMemo(() => groupWorkflows(visible, grouping), [visible, grouping]);
  const runsByWorkflow = useMemo(() => {
    const map = new Map<string, WorkflowRun[]>();
    for (const run of runs) {
      const list = map.get(run.workflowId);
      if (list) list.push(run);
      else map.set(run.workflowId, [run]);
    }
    return map;
  }, [runs]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const wf of workflows) {
      const key = wf.category || UNCATEGORIZED;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [workflows]);

  const runNow = async (wf: Workflow) => {
    setBusyId(wf.id);
    try {
      const run = await window.nekko.runWorkflow(wf.id);
      if (!run) pushToast('error', `"${wf.name}" didn't start. It may already be running, or have no steps.`);
      else if (run.status === 'success') pushToast('success', `"${wf.name}" passed.`);
      else pushToast('error', `"${wf.name}" ${run.status}${run.message ? `: ${run.message}` : ''}`);
    } catch (e) {
      pushToast('error', `Could not run "${wf.name}": ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (wf: Workflow) => {
    if (!confirm(`Delete "${wf.name}"? Its run history goes too.`)) return;
    setSnapshot(await window.nekko.deleteWorkflow(wf.id));
  };

  const duplicate = async (wf: Workflow) => {
    const copy = await window.nekko.duplicateWorkflow(wf.id);
    if (copy) {
      pushToast('info', `Copied as "${copy.name}", disabled until you turn it on.`);
      setExpanded(copy.id);
    }
  };

  const toggleEnabled = async (wf: Workflow) => {
    await window.nekko.updateWorkflow(wf.id, { enabled: !wf.enabled });
  };

  return (
    <div className="flex h-full min-h-0">
      {section === 'ciRunners' ? <CiRunnersView segment={<SectionSegment value={section} onChange={setSection} />} /> : <>
      {/* Filters */}
      {workflows.length > 0 && <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-(--line) px-3 py-3">
        <input
          className="input w-full text-[12.5px]"
          placeholder="Search workflows…"
          value={filter.query ?? ''}
          onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value || undefined }))}
        />

        <FilterGroup label="Group by">
          <div className="flex gap-1">
            {(['category', 'listener'] as WorkflowGrouping[]).map((g) => (
              <button
                key={g}
                title={
                  g === 'category'
                    ? 'Group by what each workflow is for (Code review, Maintenance…)'
                    : 'Group by what starts it — "what runs when a PR opens"'
                }
                className={`flex-1 rounded-lg border px-2 py-1 text-[11.5px] transition ${grouping === g ? 'border-transparent' : 'border-line text-ink-faint'}`}
                style={grouping === g ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
                onClick={() => setGrouping(g)}
              >
                {g === 'category' ? 'Category' : 'Trigger'}
              </button>
            ))}
          </div>
        </FilterGroup>

        <FilterGroup label="State">
          <div className="flex gap-1">
            {([undefined, 'enabled', 'disabled'] as const).map((s) => (
              <button
                key={s ?? 'all'}
                className={`flex-1 rounded-lg border px-2 py-1 text-[11.5px] transition ${filter.state === s ? 'border-transparent' : 'border-line text-ink-faint'}`}
                style={filter.state === s ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
                onClick={() => setFilter((f) => ({ ...f, state: s }))}
              >
                {s ? s[0].toUpperCase() + s.slice(1) : 'All'}
              </button>
            ))}
          </div>
        </FilterGroup>

        <FilterGroup label="Starts when">
          {TRIGGER_FAMILIES.map((fam) => (
            <div key={fam.label} className="mb-2">
              <p className="mb-1 text-[10.5px] text-ink-faint">{fam.label}</p>
              <div className="flex flex-wrap gap-1">
                {fam.kinds.map((kind) => {
                  const k = WORKFLOW_TRIGGER_KINDS.find((x) => x.kind === kind)!;
                  const on = filter.triggerKind === k.kind;
                  return (
                    <button
                      key={k.kind}
                      title={k.hint}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition ${on ? 'border-transparent' : 'border-line text-ink-faint'}`}
                      style={on ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
                      onClick={() => setFilter((f) => ({ ...f, triggerKind: on ? undefined : (k.kind as WorkflowTriggerKind) }))}
                    >
                      {k.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </FilterGroup>

        <FilterGroup label={`Categories (${categories.length})`}>
          <div className="space-y-0.5">
            <CategoryRow label="All" count={workflows.length} active={!filter.category} onClick={() => setFilter((f) => ({ ...f, category: undefined }))} />
            {categories.map(([name, count]) => (
              <CategoryRow
                key={name}
                label={name}
                count={count}
                active={filter.category === name}
                onClick={() => setFilter((f) => ({ ...f, category: f.category === name ? undefined : name }))}
              />
            ))}
          </div>
        </FilterGroup>
      </aside>}

      {/* List */}
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {!loaded ? <p className="p-4 text-[13px] text-ink-soft" role="status">{loadFailed ? 'Could not load workflows. Reopen this tab to try again.' : 'Loading workflows…'}</p> : workflows.length === 0 ? (<>
          {/* The wizard replaces the list header, so keep the switcher: CI runners must stay reachable with no workflows. */}
          <div className="mx-auto max-w-4xl px-4 sm:px-8"><SectionSegment value={section} onChange={setSection} /></div>
          <FirstWorkflowWizard onCreate={(seed) => setCreating({ seed })} onBrowse={() => setPicking(true)} />
        </>) : <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-baseline gap-2">
            {!hasAppChrome && <h1 className="view-title">Workflows</h1>}
            <SectionSegment value={section} onChange={setSection} />
            <span className="text-[12px] text-ink-faint">
              {visible.length === workflows.length
                ? `${workflows.length} total`
                : `${visible.length} of ${workflows.length}`}
            </span>
            <label
              className="ml-auto flex items-center gap-2 text-[12px] text-ink-soft"
              title="Stops schedules, events and polls from starting runs, and stops what is running now. Run buttons still work."
            >
              Pause all automations
              <Toggle value={paused} onChange={(v) => void togglePaused(v)} label="Pause all automations" />
            </label>
            <button className="btn btn-primary py-1.5!" onClick={() => setPicking(true)}>
              <PlusIcon className="h-3.5 w-3.5" /> New workflow
            </button>
          </div>
          <p className="mt-1 text-[12.5px] text-ink-soft">
            A workflow is a small automation: named steps run in order and can loop back. A trigger is what starts it —
            by hand, on a schedule, or when something happens.
          </p>

          {paused && (
            <div
              className="mt-2 flex items-center gap-3 rounded-xl border px-3 py-2 text-[12.5px]"
              style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}
              role="status"
              data-automations-paused
            >
              <span className="min-w-0 flex-1">
                <strong className="font-semibold">Automations are paused.</strong> Schedules, events and polls won't start runs, and
                scheduled tasks wait. Run still works.
              </span>
              <button className="btn btn-outline py-1! text-[12px]" onClick={() => void togglePaused(false)}>Resume</button>
            </div>
          )}

          <details className="mt-2 rounded-xl border px-3 py-2 text-[12px] text-ink-soft" style={{ borderColor: 'var(--line)' }} open={workflows.length === 0}>
            <summary className="cursor-pointer font-medium text-ink-faint">How workflows work</summary>
            <dl className="mt-2 space-y-1.5">
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 font-medium">Automation</dt>
                <dd className="text-ink-faint">
                  The whole thing: steps (an agent prompt, a shell command, a skill, another workflow) plus the triggers
                  that set them off. A verify step that finds problems can send the run back to build and try again.
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 font-medium">Manual trigger</dt>
                <dd className="text-ink-faint">
                  Started by you: the <strong>Run</strong> button, or <code className="font-mono text-[11px]">nekko-agent workflow run</code> in a
                  terminal. Every workflow can run by hand, even one whose other triggers are off.
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 font-medium">Scheduled job</dt>
                <dd className="text-ink-faint">
                  A schedule trigger: a cron expression or a plain interval ("every night", "every 15 minutes"). This
                  machine must be awake when it fires.
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 font-medium">Event triggers</dt>
                <dd className="text-ink-faint">
                  Something else starts it: a pull request or push (git), a Slack message, a poll of a connector like
                  Linear, or a webhook another service calls.
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 font-medium">Groupings</dt>
                <dd className="text-ink-faint">
                  The sidebar sorts the list two ways: <strong>Category</strong> is what a workflow is for
                  ("Code review"); <strong>Trigger</strong> is what starts it ("GitHub · pull request"), so one heading
                  answers "what runs when a PR opens".
                </dd>
              </div>
            </dl>
          </details>

          {workflows.length > 0 && visible.length === 0 && (
            <EmptyHint className="mt-4">
              Nothing matches those filters.{' '}
              <button className="underline" onClick={() => setFilter({})}>Clear them</button>.
            </EmptyHint>
          )}

          <div className="mt-4 space-y-4">
            {groups.map((group) => (
              <WorkflowGroupBlock
                key={group.key}
                label={group.label}
                workflows={group.workflows}
                runsByWorkflow={runsByWorkflow}
                grouping={grouping}
                expanded={expanded}
                busyId={busyId}
                onExpand={(id) => setExpanded((cur) => (cur === id ? null : id))}
                onRun={runNow}
                onEdit={setEditing}
                onDuplicate={duplicate}
                onDelete={remove}
                onToggle={toggleEnabled}
                focusRun={focusRun}
              />
            ))}
          </div>
        </div>}
      </div>
      </>}

      {picking && (
        <TemplateGallery
          onSetup={(t) => { setPicking(false); setSetup(t); }}
          onCustomize={(t) => { setPicking(false); setCreating({ seed: templateSeed(t) }); }}
          onClose={() => setPicking(false)}
        />
      )}

      {setup && (
        <TemplateSetup
          template={setup}
          skills={skills}
          onClose={() => setSetup(null)}
          onCustomize={(seed) => { setSetup(null); setCreating({ seed }); }}
          onTurnOn={async (input) => {
            const created = await window.nekko.createWorkflow(input);
            setSetup(null);
            if (!created) return;
            setExpanded(created.id);
            const fresh = await window.nekko.listWorkflows();
            setSnapshot(fresh);
            const next = fresh.workflows.find((w) => w.id === created.id)?.nextRunAt;
            pushToast('success', `"${created.name}" is on.${next ? ` First run ${relative(next)}.` : ''}`);
          }}
        />
      )}

      {(creating || editing) && (
        <WorkflowEditor
          workflow={editing ?? undefined}
          seed={creating?.seed}
          workflows={workflows}
          skills={skills}
          onClose={() => { setCreating(null); setEditing(null); }}
          onSave={async (patch) => {
            if (editing) await window.nekko.updateWorkflow(editing.id, patch as Partial<Workflow>);
            else {
              const created = await window.nekko.createWorkflow(patch);
              if (created) setExpanded(created.id);
            }
            setSnapshot(await window.nekko.listWorkflows());
          }}
        />
      )}
    </div>
  );
}

/** Switches the tab between workflows and this Mac's CI runners. */
export function SectionSegment({ value, onChange }: { value: 'workflows' | 'ciRunners'; onChange(v: 'workflows' | 'ciRunners'): void }) {
  return (
    <div role="group" aria-label="Section" className="flex gap-1">
      {(['workflows', 'ciRunners'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          className={`rounded-lg border px-2 py-1 text-[11.5px] transition ${value === v ? 'border-transparent' : 'border-line text-ink-faint'}`}
          style={value === v ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
          onClick={() => onChange(v)}
        >
          {v === 'workflows' ? 'Workflows' : 'CI runners'}
        </button>
      ))}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      {children}
    </div>
  );
}

function CategoryRow({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[12px] transition hover:bg-(--surface-2) ${active ? 'bg-(--surface-2) font-medium' : ''}`}
      onClick={onClick}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-[10.5px] tabular-nums text-ink-faint">{count}</span>
    </button>
  );
}

function WorkflowGroupBlock({
  label, workflows, runsByWorkflow, grouping, expanded, busyId, onExpand, onRun, onEdit, onDuplicate, onDelete, onToggle, focusRun,
}: {
  label: string;
  workflows: Workflow[];
  runsByWorkflow: Map<string, WorkflowRun[]>;
  grouping: WorkflowGrouping;
  expanded: string | null;
  busyId: string | null;
  onExpand: (id: string) => void;
  onRun: (wf: Workflow) => void;
  onEdit: (wf: Workflow) => void;
  onDuplicate: (wf: Workflow) => void;
  onDelete: (wf: Workflow) => void;
  onToggle: (wf: Workflow) => void;
  focusRun: { workflowId: string; runId: string } | null;
}) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? workflows : workflows.slice(0, ROWS_PER_GROUP);
  const hidden = workflows.length - shown.length;

  return (
    <section>
      <button className="flex w-full items-baseline gap-2 py-1 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="w-3 text-[10px] text-ink-faint">{open ? '▾' : '▸'}</span>
        <h2 className="text-[13.5px] font-semibold">{label}</h2>
        <span className="font-mono text-[10.5px] text-ink-faint">{workflows.length}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1.5">
          {shown.map((wf) => (
            <WorkflowRow
              key={`${label}-${wf.id}`}
              wf={wf}
              runs={runsByWorkflow.get(wf.id) ?? []}
              grouping={grouping}
              expanded={expanded === wf.id}
              busy={busyId === wf.id}
              onExpand={() => onExpand(wf.id)}
              onRun={() => onRun(wf)}
              onEdit={() => onEdit(wf)}
              onDuplicate={() => onDuplicate(wf)}
              onDelete={() => onDelete(wf)}
              onToggle={() => onToggle(wf)}
              focusRunId={focusRun?.workflowId === wf.id ? focusRun.runId : undefined}
            />
          ))}
          {hidden > 0 && (
            <button className="btn btn-ghost w-full py-1! text-[12px] text-ink-soft" onClick={() => setShowAll(true)}>
              Show {hidden} more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function WorkflowRow({
  wf, runs, grouping, expanded, busy, onExpand, onRun, onEdit, onDuplicate, onDelete, onToggle, focusRunId,
}: {
  wf: Workflow;
  runs: WorkflowRun[];
  grouping: WorkflowGrouping;
  expanded: boolean;
  busy: boolean;
  onExpand: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggle: () => void;
  focusRunId?: string;
}) {
  const live = runs.find((r) => r.status === 'running');
  const last = runs[0];
  const tone = live ? STATUS_TONE.running : wf.lastStatus ? STATUS_TONE[wf.lastStatus] : undefined;

  return (
    <div className="card overflow-hidden" data-workflow-row={wf.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onExpand} aria-expanded={expanded}>
          <span className="w-3 shrink-0 text-[10px] text-ink-faint">{expanded ? '▾' : '▸'}</span>
          <StatusDot color={tone?.color ?? STATUS.neutral} pulse={!!live} title={tone?.label ?? 'never run'} />
          <span className={`truncate text-[13px] font-medium ${wf.enabled ? '' : 'text-ink-faint'}`}>{wf.name}</span>
          {!wf.enabled && <Badge tone="neutral">off</Badge>}
          <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">
            {wf.steps.length} step{wf.steps.length === 1 ? '' : 's'}
          </span>
        </button>

        {/* Grouping by listener already says why it's here, so the row shows the
            other axis instead of repeating the group heading. */}
        <span className="hidden min-w-0 shrink items-center gap-1 sm:flex">
          {grouping === 'listener' ? (
            <Badge tone="info">{wf.category || UNCATEGORIZED}</Badge>
          ) : (
            listenerKeys(wf).slice(0, 2).map((k) => <Badge key={k} tone="info">{listenerLabel(k)}</Badge>)
          )}
        </span>

        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-faint">
          {!live && last && isRunnerRun(last) && <Badge tone="info" title="Fired by an external event">runner</Badge>}
          {!live && wf.waitingSince && (
            <span data-workflow-waiting>
              <Badge
                tone="info"
                title={`Its schedule came due ${relative(wf.waitingSince)}. It runs once nobody is using this computer, or after 2 hours. Run starts it now.`}
              >
                waiting for you to be away
              </Badge>
            </span>
          )}
          {live
            ? 'running now'
            : last
              ? `${STATUS_TONE[last.status].label} ${relative(last.startedAt)} · ${formatDuration(runDurationMs(last))}${last.triggerLabel ? ` · ${last.triggerLabel}` : ''}`
              : wf.nextRunAt
                ? `next ${relative(wf.nextRunAt)}`
                : 'never run'}
        </span>

        <span className="flex shrink-0 items-center gap-1">
          {live ? (
            <button className="btn btn-outline py-1! text-[12px]" onClick={() => void window.nekko.cancelWorkflowRun(live.id)}>
              Stop
            </button>
          ) : (
            <button
              className="btn btn-outline py-1! text-[12px]"
              disabled={busy || wf.steps.length === 0}
              title="Run it now — a manual trigger; works even when the workflow's other triggers are off"
              onClick={onRun}
            >
              {busy ? 'Running…' : 'Run'}
            </button>
          )}
          <button className="btn btn-ghost py-1! text-[12px]" onClick={onEdit}>Edit</button>
          <button className="btn btn-ghost px-1.5! py-1! text-[12px] text-ink-faint" title={wf.enabled ? 'Disable' : 'Enable'} onClick={onToggle}>
            {wf.enabled ? '◉' : '○'}
          </button>
          <button className="btn btn-ghost px-1.5! py-1! text-[12px] text-ink-faint" title="Duplicate" onClick={onDuplicate}>⧉</button>
          <button className="btn btn-ghost px-1.5! py-1! text-[12px] text-danger" title="Delete" onClick={onDelete}>✕</button>
        </span>
      </div>

      {expanded && <WorkflowDetail wf={wf} runs={runs} live={live} focusRunId={focusRunId} />}
    </div>
  );
}

function WorkflowDetail({ wf, runs, live, focusRunId }: { wf: Workflow; runs: WorkflowRun[]; live?: WorkflowRun; focusRunId?: string }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(focusRunId ?? null);
  useEffect(() => { if (focusRunId) setSelectedRunId(focusRunId); }, [focusRunId]);
  // A run picked from the history (or a notification) wins over the live one.
  const shownRun = runs.find((r) => r.id === selectedRunId) ?? live ?? runs[0];
  const outcome = shownRun ? runOutcome(shownRun, wf.steps) : {};
  const openChat = useStore((s) => s.openChatPane);
  const setView = useStore((s) => s.setView);
  const transcript = (sessionId?: string) =>
    sessionId && (
      <button
        className="btn btn-ghost shrink-0 px-1.5! py-0.5! text-[11px] text-ink-soft"
        title="Open this step's transcript"
        onClick={() => { openChat(sessionId); setView('command'); }}
      >
        Transcript
      </button>
    );

  return (
    <div className="border-t border-line bg-(--surface-2) px-3.5 py-3">
      {wf.description && <p className="text-[12.5px] text-ink-soft">{wf.description}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {wf.triggers.map((t) => (
          <Badge
            key={t.id}
            tone={t.enabled === false ? 'neutral' : 'info'}
            title={
              t.enabled === false
                ? 'Not armed — this trigger never starts the workflow. The Run button still does.'
                : (WORKFLOW_TRIGGER_KINDS.find((k) => k.kind === t.kind)?.hint ?? undefined)
            }
          >
            {triggerLabel(t, wf)}
          </Badge>
        ))}
        {wf.triggers.some((t) => t.kind === 'cli') && (
          <span className="font-mono text-[10.5px] text-ink-faint">nekko-agent workflow run {cliCommand(wf)}</span>
        )}
      </div>

      <div className="mt-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
          {shownRun ? `Steps · ${STATUS_TONE[shownRun.status].label} run` : 'Steps'}
        </p>
        <WorkflowCanvas steps={wf.steps} run={shownRun} />
      </div>

      {shownRun && (
        <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_220px]">
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              This run · {STATUS_TONE[shownRun.status].label}
              {shownRun.status !== 'running' && ` in ${formatDuration(runDurationMs(shownRun))}`} · {relative(shownRun.startedAt)}
              {runPolicyNote(shownRun.lowPriority, shownRun.waitedMs) && ` · ${runPolicyNote(shownRun.lowPriority, shownRun.waitedMs)}`}
            </p>
            {outcome.failed && (
              <div className="mb-2 rounded-lg border px-2.5 py-2" style={{ borderColor: STATUS.danger }} data-run-failure>
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-[12px]">
                    <span className="font-semibold" style={{ color: STATUS.danger }}>Failed at "{outcome.failed.name}"</span>
                    {outcome.failed.text && (
                      <span className="mt-0.5 block max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-ink-soft">
                        {outcome.failed.text.slice(-600)}
                      </span>
                    )}
                  </span>
                  {transcript(outcome.failed.sessionId)}
                </div>
              </div>
            )}
            {outcome.result && (
              <div className="mb-2 rounded-lg border border-line bg-(--surface) px-2.5 py-2" data-run-result>
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">Result</span>
                    <span className="mt-0.5 block max-h-48 overflow-y-auto whitespace-pre-wrap text-[12px] leading-snug">{outcome.result.text}</span>
                  </span>
                  {transcript(outcome.result.sessionId)}
                </div>
              </div>
            )}
            {shownRun.message && shownRun.message !== outcome.failed?.text && (
              <p className="mb-1.5 text-[11.5px]" style={{ color: shownRun.status === 'failure' ? STATUS.danger : 'var(--ink-soft)' }}>
                {shownRun.message}
              </p>
            )}
            <div className="space-y-1">
              {shownRun.steps.map((entry, i) => {
                const step = wf.steps.find((s) => s.id === entry.stepId);
                const t = STATUS_TONE[entry.status === 'skipped' ? 'cancelled' : entry.status === 'pending' ? 'queued' : entry.status];
                return (
                  <div key={`${entry.stepId}-${i}`} className="flex items-start gap-2 text-[11.5px]">
                    <StatusDot color={t.color} pulse={entry.status === 'running'} className="mt-1.5" />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{step?.name ?? entry.stepId}</span>
                      {entry.attempt > 1 && <span className="ml-1 font-mono text-[10px] text-ink-faint">attempt {entry.attempt}</span>}
                      {step && <span className="ml-1.5 text-ink-faint">{stepSummary(step)}</span>}
                      {entry.error && <span className="block text-[11px]" style={{ color: STATUS.danger }}>{entry.error}</span>}
                      {entry.output && !entry.error && (
                        <span className="mt-0.5 block max-h-16 overflow-y-auto whitespace-pre-wrap font-mono text-[10.5px] text-ink-faint">
                          {entry.output.slice(-400)}
                        </span>
                      )}
                    </span>
                    {transcript(entry.sessionId)}
                  </div>
                );
              })}
              {shownRun.steps.length === 0 && <p className="text-[11.5px] text-ink-faint">No steps recorded yet.</p>}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">History</p>
            <div className="space-y-0.5">
              {runs.slice(0, 10).map((r) => {
                const failedAt = runOutcome(r, wf.steps).failed?.name;
                return (
                  <button
                    key={r.id}
                    className={`flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-[11.5px] transition hover:bg-(--surface) ${r.id === shownRun.id ? 'bg-(--surface)' : ''}`}
                    onClick={() => setSelectedRunId(r.id)}
                    data-run-id={r.id}
                  >
                    <StatusDot color={STATUS_TONE[r.status].color} pulse={r.status === 'running'} className="mt-1" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{r.triggerLabel || r.triggerKind}</span>
                      <span className="block truncate text-[10.5px] text-ink-faint">
                        {isRunnerRun(r) && <span title="Fired by an external event">runner · </span>}
                        {STATUS_TONE[r.status].label}
                        {r.status !== 'running' && ` · ${formatDuration(runDurationMs(r))}`}
                        {failedAt && ` · at ${failedAt}`}
                        {runPolicyNote(r.lowPriority, r.waitedMs) && <span data-run-policy-note>{` · ${runPolicyNote(r.lowPriority, r.waitedMs)}`}</span>}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">{relative(r.startedAt)}</span>
                  </button>
                );
              })}
              {runs.length === 0 && <p className="text-[11.5px] text-ink-faint">No runs yet.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** "3m ago" / "in 2h", short enough for a dense row. */
function relative(at: number): string {
  const delta = at - Date.now();
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60_000);
  const text = mins < 1 ? 'just now' : mins < 60 ? `${mins}m` : abs < 86_400_000 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  if (text === 'just now') return text;
  return delta > 0 ? `in ${text}` : `${text} ago`;
}

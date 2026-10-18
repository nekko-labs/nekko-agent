import React, { useMemo, useState } from 'react';
import type {
  ConnectorKind,
  GitEvent,
  GitProvider,
  NewWorkflow,
  SkillDef,
  Workflow,
  WorkflowActionSpec,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowTransition,
  WorkflowTrigger,
  WorkflowTriggerKind,
  WorkflowNotify,
} from '@nekko-agent/shared';
import {
  CONNECTOR_CATALOG,
  DEFAULT_WORKFLOW_CATEGORIES,
  GIT_EVENTS,
  GIT_PROVIDERS,
  UNCATEGORIZED,
  WORKFLOW_ACTIONS,
  WORKFLOW_NOTIFY_OPTIONS,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_TRIGGER_KINDS,
  cliCommand,
  findWorkflowAction,
  formatEvery,
  isValidCron,
  newStepId,
  nextCronRun,
  slugify,
  unreachableSteps,
} from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { Modal } from './primitives/index.js';
import { WorkflowCanvas } from './WorkflowCanvas.js';
import { CloseIcon, PlusIcon } from '../icons.js';

/**
 * Create or edit one workflow: what it's called, when it fires, and the steps it
 * runs. The step editor is where the routing lives, each step picks where the run
 * goes next on success and on failure, and the canvas above redraws as you change
 * it so a loop back to an earlier step is visible while you're building it.
 *
 * Nothing is saved until Save, so an abandoned edit leaves the workflow alone.
 */

interface Draft {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  workspaceId?: string;
  notify: WorkflowNotify;
  templateId?: string;
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
}

/** What a template hands the editor for a new workflow ("Customize" in the gallery). */
export interface WorkflowSeed {
  name?: string;
  category?: string;
  description?: string;
  workspaceId?: string;
  notify?: WorkflowNotify;
  templateId?: string;
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
}

function toDraft(wf?: Workflow): Draft {
  return {
    name: wf?.name ?? '',
    description: wf?.description ?? '',
    category: wf?.category ?? UNCATEGORIZED,
    enabled: wf?.enabled ?? true,
    workspaceId: wf?.workspaceId,
    notify: wf?.notify ?? 'failure',
    templateId: wf?.templateId,
    steps: (wf?.steps ?? []).map((s) => ({ ...s })),
    triggers: (wf?.triggers ?? [{ id: newStepId('trg'), kind: 'manual' }]).map((t) => ({ ...t })),
  };
}

export function WorkflowEditor({
  workflow,
  seed,
  workflows,
  skills,
  onClose,
  onSave,
}: {
  /** The workflow being edited, or undefined when creating one. */
  workflow?: Workflow;
  /** Starting steps/triggers for a new workflow (from a template). */
  seed?: WorkflowSeed;
  /** Every workflow, so a `workflow` step can pick a target. */
  workflows: Workflow[];
  /** Installed skills, so a `skill` step can pick one. */
  skills: SkillDef[];
  onClose: () => void;
  onSave: (patch: NewWorkflow) => Promise<void> | void;
}) {
  const settings = useStore((s) => s.settings);
  const setView = useStore((s) => s.setView);
  /** Connectors with stored credentials, so an action step can grey out ops it can't run. */
  const connectedKinds = useMemo(
    () => new Set<ConnectorKind>((settings?.connectors ?? []).filter((c) => c.connected).map((c) => c.kind)),
    [settings?.connectors],
  );
  const [draft, setDraft] = useState<Draft>(() => {
    const base = toDraft(workflow);
    return seed
      ? {
          ...base,
          name: seed.name ?? base.name,
          description: seed.description ?? base.description,
          category: seed.category ?? base.category,
          workspaceId: seed.workspaceId ?? base.workspaceId,
          notify: seed.notify ?? base.notify,
          templateId: seed.templateId,
          steps: seed.steps,
          triggers: seed.triggers,
        }
      : base;
  });
  const [busy, setBusy] = useState(false);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const patchStep = (id: string, patch: Partial<WorkflowStep>) =>
    set('steps', draft.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const patchTrigger = (id: string, patch: Partial<WorkflowTrigger>) =>
    set('triggers', draft.triggers.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const unreachable = useMemo(() => new Set(unreachableSteps(draft.steps)), [draft.steps]);
  const canSave = draft.name.trim().length > 0 && draft.steps.length > 0 && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      await onSave({
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        category: draft.category.trim() || UNCATEGORIZED,
        enabled: draft.enabled,
        workspaceId: draft.workspaceId,
        notify: draft.notify,
        templateId: draft.templateId,
        steps: draft.steps,
        triggers: draft.triggers,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const addStep = () =>
    setDraft((d) => ({
      ...d,
      steps: [...d.steps, { id: newStepId(), name: `Step ${d.steps.length + 1}`, kind: 'prompt', run: '' }],
    }));

  const removeStep = (id: string) =>
    setDraft((d) => ({
      ...d,
      // Any route that pointed at the removed step falls back to the default, so
      // the workflow can't be left pointing at something that isn't there.
      steps: d.steps
        .filter((s) => s.id !== id)
        .map((s) => ({
          ...s,
          onSuccess: routeStillValid(s.onSuccess, id) ? s.onSuccess : undefined,
          onFailure: routeStillValid(s.onFailure, id) ? s.onFailure : undefined,
        })),
    }));

  const moveStep = (id: string, delta: number) =>
    setDraft((d) => {
      const i = d.steps.findIndex((s) => s.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= d.steps.length) return d;
      const steps = [...d.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...d, steps };
    });

  return (
    <Modal title={workflow ? `Edit ${workflow.name}` : 'New workflow'} onClose={onClose} align="top" className="w-full max-w-4xl px-4">
      <div className="card max-h-[86vh] overflow-y-auto p-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{workflow ? 'Edit workflow' : 'New workflow'}</h2>
            <p className="mt-0.5 text-[12px] text-ink-faint">
              Steps run in order unless a step routes elsewhere. Point a failure back at an earlier step to build a
              retry loop.
            </p>
          </div>
          <button className="btn btn-ghost px-2! py-1!" aria-label="Close" onClick={onClose}>
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Identity */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Name</span>
            <input
              className="input w-full"
              placeholder="Review every new PR"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Category</span>
            <input
              className="input w-full"
              list="wf-categories"
              placeholder={UNCATEGORIZED}
              value={draft.category}
              onChange={(e) => set('category', e.target.value)}
            />
            <datalist id="wf-categories">
              {DEFAULT_WORKFLOW_CATEGORIES.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              Description (optional)
            </span>
            <input
              className="input w-full"
              placeholder="What this does, and when you'd want it"
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Workspace</span>
            <select className="input w-full" value={draft.workspaceId ?? ''} onChange={(e) => set('workspaceId', e.target.value || undefined)}>
              <option value="">(first workspace)</option>
              {(settings?.workspaces ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name ?? w.path}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Notify me</span>
            <select className="input w-full" value={draft.notify} onChange={(e) => set('notify', e.target.value as WorkflowNotify)}>
              {WORKFLOW_NOTIFY_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <label className="flex items-end gap-2 pb-1.5 sm:col-span-2">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span className="text-[12.5px]">Enabled (triggers fire)</span>
          </label>
        </div>

        {/* Canvas preview */}
        <div className="mt-5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-semibold">The graph</h3>
            <span className="text-[11.5px] text-ink-faint">updates as you edit</span>
          </div>
          <div className="mt-2">
            <WorkflowCanvas steps={draft.steps} selectedId={selectedStep} onSelect={setSelectedStep} />
          </div>
          {unreachable.size > 0 && (
            <p className="mt-2 text-[11.5px]" style={{ color: 'var(--warning)' }}>
              {unreachable.size} step{unreachable.size === 1 ? '' : 's'} can never run: nothing routes to{' '}
              {draft.steps.filter((s) => unreachable.has(s.id)).map((s) => `"${s.name}"`).join(', ')}.
            </p>
          )}
        </div>

        {/* Steps */}
        <div className="mt-5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-semibold">Steps</h3>
            <span className="text-[11.5px] text-ink-faint">{draft.steps.length}</span>
            <button className="btn btn-outline ml-auto px-2! py-1! text-[12px]" onClick={addStep}>
              <PlusIcon className="h-3 w-3" /> Add step
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {draft.steps.length === 0 && (
              <p className="rounded-xl border border-dashed border-line px-4 py-3.5 text-[12.5px] text-ink-faint">
                A workflow needs at least one step.
              </p>
            )}
            {draft.steps.map((step, i) => (
              <StepEditor
                key={step.id}
                step={step}
                index={i}
                total={draft.steps.length}
                steps={draft.steps}
                workflows={workflows.filter((w) => w.id !== workflow?.id)}
                skills={skills}
                unreachable={unreachable.has(step.id)}
                connectedKinds={connectedKinds}
                onGoConnectors={() => { onClose(); setView('connectors'); }}
                onPatch={(patch) => patchStep(step.id, patch)}
                onRemove={() => removeStep(step.id)}
                onMove={(d) => moveStep(step.id, d)}
                onFocus={() => setSelectedStep(step.id)}
                highlighted={selectedStep === step.id}
              />
            ))}
          </div>
        </div>

        {/* Triggers */}
        <div className="mt-5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-semibold">Triggers</h3>
            <span className="text-[11.5px] text-ink-faint">what starts it</span>
            <button
              className="btn btn-outline ml-auto px-2! py-1! text-[12px]"
              onClick={() => set('triggers', [...draft.triggers, { id: newStepId('trg'), kind: 'manual' }])}
            >
              <PlusIcon className="h-3 w-3" /> Add trigger
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {draft.triggers.length === 0 && (
              <p className="rounded-xl border border-dashed border-line px-4 py-3.5 text-[12.5px] text-ink-faint">
                No triggers, so this only runs when you press Run.
              </p>
            )}
            {draft.triggers.map((trigger) => (
              <TriggerEditor
                key={trigger.id}
                trigger={trigger}
                slugSource={draft.name}
                onPatch={(patch) => patchTrigger(trigger.id, patch)}
                onRemove={() => set('triggers', draft.triggers.filter((t) => t.id !== trigger.id))}
              />
            ))}
          </div>
        </div>

        <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
          <button className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
            {workflow ? 'Save changes' : 'Create workflow'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {!draft.name.trim() && <span className="text-[11.5px] text-ink-faint">A name is required.</span>}
          {draft.name.trim() && draft.steps.length === 0 && (
            <span className="text-[11.5px] text-ink-faint">Add at least one step.</span>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Whether a route survives the removal of step `goneId`. */
function routeStillValid(t: WorkflowTransition | undefined, goneId: string): boolean {
  return !t || t.goto !== 'step' || t.stepId !== goneId;
}

function StepEditor({
  step, index, total, steps, workflows, skills, unreachable, connectedKinds, onGoConnectors, onPatch, onRemove, onMove, onFocus, highlighted,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  steps: WorkflowStep[];
  workflows: Workflow[];
  skills: SkillDef[];
  unreachable: boolean;
  /** Connectors with stored credentials (action steps need them to run). */
  connectedKinds: Set<ConnectorKind>;
  onGoConnectors: () => void;
  onPatch: (patch: Partial<WorkflowStep>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  onFocus: () => void;
  highlighted: boolean;
}) {
  const kindMeta = WORKFLOW_STEP_KINDS.find((k) => k.kind === step.kind);
  return (
    <div
      className="card px-3.5 py-3"
      style={highlighted ? { boxShadow: '0 0 0 2px var(--accent)' } : undefined}
      onFocusCapture={onFocus}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] text-ink-faint">{index + 1}</span>
        <input
          className="input min-w-0 flex-1 py-1! text-[12.5px]"
          placeholder="Step name"
          value={step.name}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <select
          className="input w-[112px] py-1! text-[12px]"
          value={step.kind}
          // Switching kind clears `run` (and action `params`): a shell command
          // is not a valid skill id, and a half-converted step is worse than
          // an empty one.
          onChange={(e) => onPatch({ kind: e.target.value as WorkflowStepKind, run: '', params: undefined })}
        >
          {WORKFLOW_STEP_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
        <span className="flex shrink-0 items-center gap-1">
          <button className="btn btn-ghost px-1.5! py-1! text-[12px]" disabled={index === 0} aria-label="Move up" onClick={() => onMove(-1)}>↑</button>
          <button className="btn btn-ghost px-1.5! py-1! text-[12px]" disabled={index === total - 1} aria-label="Move down" onClick={() => onMove(1)}>↓</button>
          <button className="btn btn-ghost px-1.5! py-1! text-[12px] text-danger" aria-label="Remove step" onClick={onRemove}>✕</button>
        </span>
      </div>
      {kindMeta && <p className="mt-1 text-[11px] text-ink-faint">{kindMeta.hint}</p>}
      {unreachable && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--warning)' }}>Nothing routes here, so this step never runs.</p>
      )}

      {/* What it runs, per kind */}
      <div className="mt-2">
        {step.kind === 'prompt' && (
          <textarea
            className="input min-h-[56px] w-full resize-y text-[12.5px]"
            placeholder="What the agent should do in this step"
            value={step.run}
            onChange={(e) => onPatch({ run: e.target.value })}
          />
        )}
        {step.kind === 'shell' && (
          <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
            <input
              className="input w-full font-mono text-[12px]"
              placeholder="npm run typecheck && npm test"
              value={step.run}
              onChange={(e) => onPatch({ run: e.target.value })}
            />
            <input
              className="input w-full text-[12px]"
              placeholder="working dir (optional)"
              value={step.cwd ?? ''}
              onChange={(e) => onPatch({ cwd: e.target.value || undefined })}
            />
          </div>
        )}
        {step.kind === 'skill' && (
          <select className="input w-full text-[12.5px]" value={step.run} onChange={(e) => onPatch({ run: e.target.value })}>
            <option value="">Pick a skill…</option>
            {skills.map((s) => <option key={s.id} value={s.id}>/{s.name} — {s.description}</option>)}
          </select>
        )}
        {step.kind === 'workflow' && (
          <select className="input w-full text-[12.5px]" value={step.run} onChange={(e) => onPatch({ run: e.target.value })}>
            <option value="">Pick a workflow…</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {step.kind === 'action' && (
          <ActionStepFields
            step={step}
            connectedKinds={connectedKinds}
            onPatch={onPatch}
            onGoConnectors={onGoConnectors}
          />
        )}
        {(step.kind === 'prompt' || step.kind === 'skill') && (
          <input
            className="input mt-2 w-full text-[12px]"
            placeholder="Extra context for this step (optional)"
            value={step.with ?? ''}
            onChange={(e) => onPatch({ with: e.target.value || undefined })}
          />
        )}
      </div>

      {/* Retry + routing */}
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Retries</span>
          <input
            type="number"
            min={0}
            max={10}
            className="input w-full py-1! tabular-nums"
            value={step.retries ?? 0}
            onChange={(e) => onPatch({ retries: Math.max(0, Math.min(10, Number(e.target.value) || 0)) || undefined })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Timeout (s)</span>
          <input
            type="number"
            min={0}
            className="input w-full py-1! tabular-nums"
            placeholder="600"
            value={step.timeoutSec ?? ''}
            onChange={(e) => onPatch({ timeoutSec: Number(e.target.value) || undefined })}
          />
        </label>
        <RouteSelect
          label="On success"
          value={step.onSuccess}
          steps={steps}
          selfId={step.id}
          defaultLabel={index === total - 1 ? 'Finish the run' : `Next step (${steps[index + 1]?.name || '—'})`}
          onChange={(t) => onPatch({ onSuccess: t })}
        />
        <RouteSelect
          label="On failure"
          value={step.onFailure}
          steps={steps}
          selfId={step.id}
          defaultLabel={step.continueOnError ? 'Carry on' : 'Fail the run'}
          onChange={(t) => onPatch({ onFailure: t })}
        />
      </div>
      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={!!step.continueOnError}
          onChange={(e) => onPatch({ continueOnError: e.target.checked || undefined })}
        />
        <span className="text-[11.5px] text-ink-soft">Keep going even if this step fails</span>
      </label>
      {(step.kind === 'prompt' || step.kind === 'skill') && (
        <label className="mt-1 flex items-center gap-2" title="For a step that reads text someone else wrote. Later steps share the chat, so keep it last.">
          <input
            type="checkbox"
            checked={step.tools === 'none'}
            onChange={(e) => onPatch({ tools: e.target.checked ? 'none' : undefined })}
          />
          <span className="text-[11.5px] text-ink-soft">No tools: only reads what the step gives it</span>
        </label>
      )}
    </div>
  );
}

/**
 * Action step body: pick an op from the shared WORKFLOW_ACTIONS catalog, then
 * fill in that op's params. Ops are grouped by the connector they run through
 * and greyed out while that connector isn't connected, since credentials come
 * from the connector's saved settings rather than the step.
 */
function ActionStepFields({
  step, connectedKinds, onPatch, onGoConnectors,
}: {
  step: WorkflowStep;
  connectedKinds: Set<ConnectorKind>;
  onPatch: (patch: Partial<WorkflowStep>) => void;
  onGoConnectors: () => void;
}) {
  const spec = findWorkflowAction(step.run);
  const groups = useMemo(() => {
    const by = new Map<string, WorkflowActionSpec[]>();
    for (const a of WORKFLOW_ACTIONS) {
      const list = by.get(a.group) ?? [];
      list.push(a);
      by.set(a.group, list);
    }
    return [...by.entries()].map(([label, ops]) => ({ label, ops }));
  }, []);
  const needsConnector = spec?.connector && !connectedKinds.has(spec.connector);
  const connectorLabel = spec?.connector
    ? CONNECTOR_CATALOG.find((c) => c.kind === spec.connector)?.label ?? spec.connector
    : undefined;
  const setParam = (key: string, value: string) => {
    const next = { ...(step.params ?? {}) };
    if (value) next[key] = value;
    else delete next[key];
    onPatch({ params: Object.keys(next).length ? next : undefined });
  };
  return (
    <div className="space-y-2">
      <select
        className="input w-full text-[12.5px]"
        value={step.run}
        // A new op takes new params; carrying the old keys over would leave
        // fields the op never reads.
        onChange={(e) => onPatch({ run: e.target.value, params: undefined })}
      >
        <option value="">Pick an action…</option>
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.ops.map((a) => {
              const blocked = !!a.connector && !connectedKinds.has(a.connector);
              return (
                <option key={a.op} value={a.op} disabled={blocked}>
                  {a.label}{blocked ? ` (connect ${a.group} first)` : ''}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
      {spec?.hint && <p className="text-[11px] text-ink-faint">{spec.hint}</p>}
      {needsConnector && (
        <p className="text-[11.5px]" style={{ color: 'var(--warning)' }}>
          {connectorLabel} isn't connected, so this step can't run yet.{' '}
          <button className="underline" onClick={onGoConnectors}>Connect it</button>
          {' '}— closing the editor discards this draft.
        </p>
      )}
      {spec && (
        <div className="grid gap-2 sm:grid-cols-2">
          {spec.params.map((p) => (
            <label key={p.key} className={`block ${p.multiline ? 'sm:col-span-2' : ''}`}>
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                {p.label}{p.required ? ' *' : ''}
              </span>
              {p.multiline ? (
                <textarea
                  className="input min-h-[48px] w-full resize-y text-[12.5px]"
                  placeholder={p.placeholder}
                  value={step.params?.[p.key] ?? ''}
                  onChange={(e) => setParam(p.key, e.target.value)}
                />
              ) : (
                <input
                  className="input w-full py-1! text-[12px]"
                  placeholder={p.placeholder}
                  value={step.params?.[p.key] ?? ''}
                  onChange={(e) => setParam(p.key, e.target.value)}
                />
              )}
              {p.hint && <span className="mt-0.5 block text-[10.5px] text-ink-faint">{p.hint}</span>}
            </label>
          ))}
        </div>
      )}
      {spec && (
        <p className="text-[10.5px] text-ink-faint">
          Values can interpolate the run: <code className="font-mono">{'{{trigger.branch}}'}</code>,{' '}
          <code className="font-mono">{'{{steps.<stepId>.output}}'}</code>,{' '}
          <code className="font-mono">{'{{run.status}}'}</code>.
        </p>
      )}
    </div>
  );
}

const POLLABLE_CONNECTORS: ConnectorKind[] = ['slack', 'linear', 'jira', 'github', 'gitlab'];

function connectorLabel(kind: ConnectorKind | undefined): string {
  if (!kind) return 'Connector';
  return CONNECTOR_CATALOG.find((c) => c.kind === kind)?.label ?? kind;
}

function ConnectorTriggerFields({
  trigger, onPatch,
}: {
  trigger: WorkflowTrigger;
  onPatch: (patch: Partial<WorkflowTrigger>) => void;
}) {
  const intervalMin = trigger.pollIntervalMs ? Math.max(1, Math.round(trigger.pollIntervalMs / 60_000)) : '';
  const isRepo = trigger.connector === 'github' || trigger.connector === 'gitlab';
  const isChannel = trigger.connector === 'slack' || trigger.connector === 'discord';
  const isGitHub = trigger.connector === 'github';
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <label className="block">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Connector</span>
        <select
          className="input w-full py-1! text-[12px]"
          value={trigger.connector ?? ''}
          onChange={(e) => onPatch({ connector: e.target.value as ConnectorKind, event: undefined, channel: undefined, repo: undefined, action: undefined, actor: undefined })}
        >
          <option value="">Pick a connector…</option>
          {POLLABLE_CONNECTORS.map((k) => (
            <option key={k} value={k}>{connectorLabel(k)}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Event type</span>
        <input
          className="input w-full text-[12px]"
          placeholder={trigger.connector === 'slack' ? 'message' : 'issue'}
          value={trigger.event ?? ''}
          onChange={(e) => onPatch({ event: e.target.value || undefined })}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Poll every N minutes</span>
        <input
          type="number"
          min={1}
          className="input w-full py-1! tabular-nums text-[12px]"
          placeholder="1"
          value={intervalMin}
          onChange={(e) => onPatch({ pollIntervalMs: Number(e.target.value) ? Number(e.target.value) * 60_000 : undefined })}
        />
        {trigger.pollIntervalMs && <span className="mt-1 block text-[11px] text-ink-faint">Polls every {formatEvery(trigger.pollIntervalMs)}.</span>}
      </label>
      {isChannel && (
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Channel</span>
          <input
            className="input w-full text-[12px]"
            placeholder={trigger.connector === 'slack' ? '#builds or a channel id' : 'channel id'}
            value={trigger.channel ?? ''}
            onChange={(e) => onPatch({ channel: e.target.value || undefined })}
          />
        </label>
      )}
      {isRepo && (
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Repo / project</span>
          <input
            className="input w-full text-[12px]"
            placeholder="owner/name (any)"
            value={trigger.repo ?? ''}
            onChange={(e) => onPatch({ repo: e.target.value || undefined })}
          />
        </label>
      )}
      {isGitHub && (
        <>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Action</span>
            <input
              className="input w-full text-[12px]"
              placeholder="opened (any)"
              value={trigger.action ?? ''}
              onChange={(e) => onPatch({ action: e.target.value.trim() || undefined })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Only by</span>
            <input
              className="input w-full text-[12px]"
              placeholder="GitHub username (anyone)"
              value={trigger.actor ?? ''}
              onChange={(e) => onPatch({ actor: e.target.value.trim() || undefined })}
            />
          </label>
        </>
      )}
      <label className="block sm:col-span-2">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Filter</span>
        <input
          className="input w-full text-[12px]"
          placeholder="Optional substring filter on the event text or payload"
          value={trigger.filter ?? ''}
          onChange={(e) => onPatch({ filter: e.target.value || undefined })}
        />
      </label>
      <p className="text-[11px] text-ink-faint sm:col-span-2">
        The connector must be connected under Connectors. Nekko Agent polls it on the interval and starts a run for each new matching event.
      </p>
    </div>
  );
}

function newWebhookSecret(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto & { randomUUID(): string }).randomUUID();
  }
  return `wh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function WebhookTriggerFields({
  trigger, slugSource, onPatch,
}: {
  trigger: WorkflowTrigger;
  slugSource: string;
  onPatch: (patch: Partial<WorkflowTrigger>) => void;
}) {
  const secret = trigger.webhookSecret ?? '';
  const slug = slugify(slugSource);
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <label className="block sm:col-span-2">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Webhook secret</span>
        <div className="flex gap-2">
          <input
            className="input w-full font-mono text-[12px]"
            type="text"
            readOnly
            value={secret}
            onFocus={(e) => e.target.select()}
          />
          <button
            className="btn btn-outline shrink-0 px-2! py-1! text-[12px]"
            onClick={() => onPatch({ webhookSecret: newWebhookSecret() })}
          >
            Regenerate
          </button>
        </div>
        <p className="mt-1 text-[11px] text-ink-faint">
          Keep this secret out of logs. The webhook only fires when the URL includes <code className="font-mono">?key=...</code> with this value.
        </p>
      </label>
      <div className="block sm:col-span-2">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Webhook URL</span>
        <code className="block break-all rounded-lg border border-line bg-(--surface) px-2.5 py-1.5 font-mono text-[11px] text-ink-soft">
          POST https://&lt;your-host&gt;/api/hooks/{slug}?key={secret}
        </code>
        <p className="mt-1 text-[11px] text-ink-faint">
          Requires the server edition or a reachable URL. The desktop can opt in to a loopback listener (127.0.0.1:1441) under Settings → Experimental.
        </p>
      </div>
    </div>
  );
}

/** Route picker: the default, an explicit end, a hard fail, or a named step. */
function RouteSelect({
  label, value, steps, selfId, defaultLabel, onChange,
}: {
  label: string;
  value?: WorkflowTransition;
  steps: WorkflowStep[];
  selfId: string;
  defaultLabel: string;
  onChange: (t: WorkflowTransition | undefined) => void;
}) {
  const current = !value ? 'default' : value.goto === 'step' ? `step:${value.stepId}` : value.goto;
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</span>
      <select
        className="input w-full py-1! text-[12px]"
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'default') return onChange(undefined);
          if (v === 'end') return onChange({ goto: 'end' });
          if (v === 'fail') return onChange({ goto: 'fail' });
          if (v === 'next') return onChange({ goto: 'next' });
          onChange({ goto: 'step', stepId: v.slice('step:'.length) });
        }}
      >
        <option value="default">Default ({defaultLabel})</option>
        <option value="next">Next step</option>
        <option value="end">Finish, successfully</option>
        <option value="fail">Stop, as a failure</option>
        {steps.map((s) => (
          <option key={s.id} value={`step:${s.id}`}>
            Go to: {s.name || '(unnamed)'}{s.id === selfId ? ' (itself)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function TriggerEditor({
  trigger, slugSource, onPatch, onRemove,
}: {
  trigger: WorkflowTrigger;
  slugSource: string;
  onPatch: (patch: Partial<WorkflowTrigger>) => void;
  onRemove: () => void;
}) {
  const meta = WORKFLOW_TRIGGER_KINDS.find((k) => k.kind === trigger.kind);
  const cronValid = !trigger.cron || isValidCron(trigger.cron);
  const nextFire = trigger.cron && cronValid ? nextCronRun(trigger.cron) : undefined;
  const events = new Set(trigger.events ?? []);

  return (
    <div className="card px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-[132px] py-1! text-[12px]"
          value={trigger.kind}
          onChange={(e) => {
            const kind = e.target.value as WorkflowTriggerKind;
            const patch: Partial<WorkflowTrigger> = { kind };
            if (kind === 'webhook' && !trigger.webhookSecret) {
              patch.webhookSecret = newWebhookSecret();
            }
            onPatch(patch);
          }}
        >
          {WORKFLOW_TRIGGER_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-faint">{meta?.hint}</span>
        <label className="flex shrink-0 items-center gap-1.5">
          <input type="checkbox" checked={trigger.enabled !== false} onChange={(e) => onPatch({ enabled: e.target.checked })} />
          <span className="text-[11.5px]">Armed</span>
        </label>
        <button className="btn btn-ghost px-1.5! py-1! text-[12px] text-danger" aria-label="Remove trigger" onClick={onRemove}>✕</button>
      </div>

      {trigger.kind === 'schedule' && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Cron</span>
            <input
              className="input w-full font-mono text-[12px]"
              placeholder="0 3 * * *"
              value={trigger.cron ?? ''}
              onChange={(e) => onPatch({ cron: e.target.value || undefined })}
            />
            {trigger.cron && !cronValid && (
              <span className="mt-1 block text-[11px] text-danger">
                Not a valid 5-field expression (minute hour day month weekday).
              </span>
            )}
            {nextFire && (
              <span className="mt-1 block text-[11px] text-ink-faint">Next: {new Date(nextFire).toLocaleString()}</span>
            )}
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              Or every N minutes
            </span>
            <input
              type="number"
              min={1}
              className="input w-full py-1! tabular-nums"
              placeholder="60"
              disabled={!!trigger.cron}
              value={trigger.intervalMs ? Math.round(trigger.intervalMs / 60_000) : ''}
              onChange={(e) => onPatch({ intervalMs: Number(e.target.value) ? Number(e.target.value) * 60_000 : undefined })}
            />
            {trigger.intervalMs && !trigger.cron && (
              <span className="mt-1 block text-[11px] text-ink-faint">Runs every {formatEvery(trigger.intervalMs)}.</span>
            )}
            {trigger.cron && <span className="mt-1 block text-[11px] text-ink-faint">Cron takes precedence.</span>}
          </label>
        </div>
      )}

      {trigger.kind === 'cli' && (
        <label className="mt-2 block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Command</span>
          <input
            className="input w-full font-mono text-[12px]"
            placeholder={slugSource ? cliCommand({ name: slugSource } as Workflow, undefined) : 'workflow-name'}
            value={trigger.command ?? ''}
            onChange={(e) => onPatch({ command: e.target.value || undefined })}
          />
          <span className="mt-1 block text-[11px] text-ink-faint">
            Run it with <code className="font-mono">nekko-agent workflow trigger {trigger.command?.trim() || (slugSource ? cliCommand({ name: slugSource } as Workflow, undefined) : '<command>')}</code>
          </span>
        </label>
      )}

      {trigger.kind === 'slack' && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Channel</span>
            <input
              className="input w-full text-[12px]"
              placeholder="builds"
              value={trigger.channel ?? ''}
              onChange={(e) => onPatch({ channel: e.target.value || undefined })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              Only when it contains
            </span>
            <input
              className="input w-full text-[12px]"
              placeholder="ship it"
              value={trigger.keyword ?? ''}
              onChange={(e) => onPatch({ keyword: e.target.value || undefined })}
            />
          </label>
        </div>
      )}

      {trigger.kind === 'git' && (
        <div className="mt-2 space-y-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Provider</span>
              <select
                className="input w-full py-1! text-[12px]"
                value={trigger.provider ?? 'github'}
                onChange={(e) => onPatch({ provider: e.target.value as GitProvider })}
              >
                {GIT_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Repo</span>
              <input
                className="input w-full text-[12px]"
                placeholder="owner/name (any)"
                value={trigger.repo ?? ''}
                onChange={(e) => onPatch({ repo: e.target.value || undefined })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Branches</span>
              <input
                className="input w-full text-[12px]"
                placeholder="main, release/* (any)"
                value={(trigger.branches ?? []).join(', ')}
                onChange={(e) => {
                  const list = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                  onPatch({ branches: list.length ? list : undefined });
                }}
              />
            </label>
          </div>
          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Events</span>
            <div className="flex flex-wrap gap-1.5">
              {GIT_EVENTS.map((e) => {
                const on = events.has(e.id);
                return (
                  <button
                    key={e.id}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${on ? 'border-transparent' : 'border-line text-ink-faint'}`}
                    style={on ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
                    onClick={() => {
                      const next = new Set(events);
                      if (on) next.delete(e.id);
                      else next.add(e.id);
                      onPatch({ events: next.size ? ([...next] as GitEvent[]) : undefined });
                    }}
                  >
                    {e.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-ink-faint">
              {events.size === 0 ? 'No events picked, so any event from this provider starts it.' : `${events.size} selected.`}
            </p>
          </div>
        </div>
      )}

      {trigger.kind === 'connector' && (
        <ConnectorTriggerFields trigger={trigger} onPatch={onPatch} />
      )}

      {trigger.kind === 'webhook' && (
        <WebhookTriggerFields trigger={trigger} slugSource={slugSource} onPatch={onPatch} />
      )}
    </div>
  );
}

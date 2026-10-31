import React, { useState } from 'react';
import type { NewWorkflow, SkillDef, TemplateNeed, WorkflowNotify, WorkflowTemplate } from '@nekko-agent/shared';
import {
  WORKFLOW_NOTIFY_OPTIONS,
  WORKFLOW_TEMPLATES,
  templateInputDefault,
  templateInputProblem,
  offlineProviderAllowed,
  templateInputValues,
  templateLocalModel,
  templateReadiness,
} from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { Badge, Modal } from './primitives/index.js';
import { SKILL_GROUPS, WorkflowModelField, type WorkflowSeed } from './WorkflowEditor.js';
import { CloseIcon } from '../icons.js';
import { STATUS } from '../tokens.js';

/**
 * The template gallery: ready-made automations in plain words, each one a
 * setup sheet away from running. Setup checks what the template needs
 * (connectors, a project folder, a default or local model), asks for its few inputs, and
 * turns it on. The step canvas stays one click further, behind Customize, for
 * people who want to change how it works rather than just use it.
 */

type Env = ReturnType<typeof useTemplateEnv>;

type ChosenModel = { providerId?: string; modelId?: string };

function useTemplateEnv(workspaceId?: string, model: ChosenModel = {}) {
  const settings = useStore((s) => s.settings);
  return {
    connectors: settings?.connectors ?? [],
    workspaces: settings?.workspaces ?? [],
    workspaceId: workspaceId ?? settings?.workspaces?.[0]?.id,
    defaultProviderId: settings?.defaultProviderId,
    defaultModelId: settings?.defaultModelId,
    providers: settings?.providers ?? [],
    ...model,
  };
}

/** The gallery cards, also drawn inline in the empty Workflows tab. */
export function TemplateCards({ onPick }: { onPick: (t: WorkflowTemplate) => void }) {
  const env = useTemplateEnv();
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-template-gallery>
      {WORKFLOW_TEMPLATES.filter((t) => t.featured).map((t) => (
        <TemplateCard key={t.id} template={t} needs={templateReadiness(t, env)} onClick={() => onPick(t)} />
      ))}
    </div>
  );
}

function TemplateCard({ template, needs, onClick }: { template: WorkflowTemplate; needs: TemplateNeed[]; onClick: () => void }) {
  return (
    <button className="card flex flex-col px-4 py-3 text-left transition hover:bg-(--surface-2)" onClick={onClick} data-template={template.id}>
      <span className="text-sm font-semibold leading-snug">{template.name}</span>
      <span className="mt-1 text-xs leading-snug text-ink-faint">{template.summary ?? template.description}</span>
      {needs.length > 0 && (
        <span className="mt-2 flex flex-wrap gap-1">
          {needs.map((n) => (
            <Badge key={n.id} tone={n.ok ? 'success' : 'neutral'} title={n.ok ? 'Ready' : 'Set up when you turn it on'}>
              {n.ok ? '✓ ' : ''}{n.label}
            </Badge>
          ))}
        </span>
      )}
    </button>
  );
}

/** "New workflow": featured templates first, then pattern examples, then blank. */
export function TemplateGallery({
  onSetup,
  onCustomize,
  onClose,
}: {
  onSetup: (t: WorkflowTemplate) => void;
  /** Straight to the editor: examples and blank skip the setup sheet. */
  onCustomize: (t: WorkflowTemplate) => void;
  onClose: () => void;
}) {
  const examples = WORKFLOW_TEMPLATES.filter((t) => !t.featured && t.id !== 'blank');
  const blank = WORKFLOW_TEMPLATES.find((t) => t.id === 'blank');
  return (
    <Modal title="New workflow" onClose={onClose} align="top" className="w-full max-w-2xl px-4">
      <div className="card max-h-[86vh] overflow-y-auto p-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Ready to use</h2>
            <p className="mt-0.5 text-xs text-ink-faint">Pick one, answer a question or two, and it runs on its own.</p>
          </div>
          <button className="btn btn-ghost px-2! py-1!" aria-label="Close" onClick={onClose}>
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3">
          <TemplateCards onPick={onSetup} />
        </div>

        <h2 className="mt-5 text-base font-semibold">Build your own</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Examples of a pattern to edit, or a blank workflow. These open the editor.
        </p>
        <div className="mt-3 space-y-2">
          {examples.map((t) => (
            <button key={t.id} className="card w-full px-4 py-3 text-left transition hover:bg-(--surface-2)" onClick={() => onCustomize(t)}>
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold">{t.name}</span>
                <Badge tone="info">{t.category}</Badge>
              </div>
              <p className="mt-1 text-xs leading-snug text-ink-faint">{t.description}</p>
            </button>
          ))}
          {blank && (
            <button className="card w-full border-dashed px-4 py-3 text-left transition hover:bg-(--surface-2)" onClick={() => onCustomize(blank)}>
              <span className="text-sm font-semibold">Blank workflow</span>
              <p className="mt-1 text-xs leading-snug text-ink-faint">{blank.description}</p>
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** A template's starting point for the editor or for creating it outright. */
export function templateSeed(
  t: WorkflowTemplate,
  inputs: Record<string, string> = {},
  extra: Partial<WorkflowSeed> = {},
  skills: SkillDef[] = [],
): WorkflowSeed {
  const { steps, triggers } = t.build(templateInputValues(t, inputs, skills));
  const blank = t.id === 'blank';
  return {
    name: blank ? '' : t.name,
    description: blank ? '' : t.description,
    category: t.category,
    notify: t.notify,
    templateId: blank ? undefined : t.id,
    localModelOnly: t.localModelOnly,
    toolAccess: t.toolAccess,
    prCheckout: t.prCheckout,
    steps,
    triggers,
    ...extra,
  };
}

/** Check, ask, turn on. */
export function TemplateSetup({
  template: base,
  skills = [],
  onTurnOn,
  onCustomize,
  onClose,
}: {
  template: WorkflowTemplate;
  /** What a skill input can pick (`workflow:skillDefs`). */
  skills?: SkillDef[];
  onTurnOn: (input: NewWorkflow) => Promise<void>;
  onCustomize: (seed: WorkflowSeed) => void;
  onClose: () => void;
}) {
  const setView = useStore((s) => s.setView);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [model, setModel] = useState<ChosenModel>({});
  const env: Env = useTemplateEnv(workspaceId, model);
  // "Local models only" starts on when a local model is set up; on, the template needs one.
  const [localChoice, setLocalChoice] = useState<boolean | undefined>(undefined);
  const localOnly = !!base.offerLocalOnly && (localChoice ?? !!templateLocalModel(env));
  const template: WorkflowTemplate = localOnly
    ? { ...base, localModelOnly: true, requires: { ...base.requires, model: false, localModel: true } }
    : base;
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [notify, setNotify] = useState<WorkflowNotify>(template.notify ?? 'failure');
  const [busy, setBusy] = useState(false);

  const needs = templateReadiness(template, env);
  const values = templateInputValues(template, typed, skills);
  const problems = Object.fromEntries((template.inputs ?? []).map((i) => [i.key, templateInputProblem(i, values[i.key])]));
  const ready = needs.every((n) => n.ok) && Object.values(problems).every((p) => !p) && !busy;
  // A local-only template names its model: the app default may be a cloud one.
  const localModel = template.requires?.localModel ? templateLocalModel(env) : undefined;
  const hasLocalProvider = env.providers.some((p) => p.enabled && offlineProviderAllowed(p));
  const seed = () => templateSeed(template, values, {
    notify,
    workspaceId: template.requires?.workspace ? env.workspaceId : undefined,
    providerId: localModel?.providerId,
    modelId: localModel?.modelId,
  }, skills);

  const turnOn = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const s = seed();
      await onTurnOn({
        name: s.name ?? template.name, description: s.description, category: s.category, enabled: true,
        workspaceId: s.workspaceId, notify: s.notify, templateId: s.templateId,
        providerId: s.providerId, modelId: s.modelId, localModelOnly: s.localModelOnly, toolAccess: s.toolAccess,
        prCheckout: s.prCheckout, steps: s.steps, triggers: s.triggers,
      });
    } finally {
      setBusy(false);
    }
  };

  const go = (fix: TemplateNeed['fix']) => {
    if (fix === 'workspace') return;
    onClose();
    setView(fix === 'localModel' ? 'models' : fix);
  };

  return (
    <Modal title={template.name} onClose={onClose} align="top" className="w-full max-w-lg px-4">
      <div className="card max-h-[86vh] overflow-y-auto p-5" data-template-setup={template.id}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-snug">{template.name}</h2>
            <p className="mt-1 text-xs leading-snug text-ink-soft">{template.description}</p>
          </div>
          <button className="btn btn-ghost px-2! py-1!" aria-label="Close" onClick={onClose}>
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {needs.length > 0 && (
          <section className="mt-4">
            <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">What it needs</p>
            <ul className="space-y-1">
              {needs.map((n) => (
                <li key={n.id} className="flex items-center gap-2 text-xs">
                  <span className="w-4 text-center" style={{ color: n.ok ? STATUS.success : STATUS.warning }} aria-hidden>{n.ok ? '✓' : '!'}</span>
                  <span className="min-w-0 flex-1">{n.label}</span>
                  {n.fix === 'workspace' ? (
                    <select
                      className="input max-w-52 py-1! text-xs"
                      aria-label="Project folder"
                      value={env.workspaceId ?? ''}
                      onChange={(e) => setWorkspaceId(e.target.value || undefined)}
                    >
                      {env.workspaces.length === 0 && <option value="">No folders added</option>}
                      {env.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name ?? w.path}</option>)}
                    </select>
                  ) : n.fix === 'localModel' && hasLocalProvider ? (
                    <WorkflowModelField
                      providers={env.providers}
                      providerId={localModel?.providerId}
                      modelId={localModel?.modelId}
                      unsetLabel="Choose a local model"
                      localOnly
                      onChange={(providerId, modelId) => setModel({ providerId, modelId })}
                    />
                  ) : n.ok ? (
                    n.fix === 'models' && <span className="truncate font-mono text-2xs text-ink-faint">{env.defaultModelId}</span>
                  ) : (
                    <button className="btn btn-outline py-0.5! text-xs" onClick={() => go(n.fix)}>
                      {n.fix === 'connectors' ? 'Connect' : n.fix === 'localModel' ? 'Set up a local model' : 'Choose a model'}
                    </button>
                  )}
                </li>
              ))}
              {(template.notes ?? []).map((note) => (
                <li key={note} className="flex items-center gap-2 text-xs text-ink-soft">
                  <span className="w-4 text-center text-ink-faint" aria-hidden>·</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {base.offerLocalOnly && (
          <label className="mt-3 flex items-start gap-2" data-template-local-only>
            <input type="checkbox" className="mt-0.5" checked={localOnly} onChange={(e) => setLocalChoice(e.target.checked)} />
            <span className="text-xs">
              Local models only
              <span className="block text-2xs text-ink-faint">
                The review runs on a model on this computer and never reaches a cloud provider.
                {!hasLocalProvider && ' No local model is set up yet.'}
              </span>
            </span>
          </label>
        )}

        {(template.inputs ?? []).length > 0 && (
          <section className="mt-4 space-y-3">
            {template.inputs!.map((input) => {
              const problem = touched.has(input.key) ? problems[input.key] : undefined;
              if (input.kind === 'skill') {
                const value = values[input.key];
                const known = skills.some((sk) => sk.id === value);
                return (
                  <label key={input.key} className="block" data-template-skill>
                    <span className="mb-1 block text-2xs font-semibold uppercase tracking-wide text-ink-faint">{input.label}</span>
                    <select
                      className="input w-full"
                      value={value}
                      onChange={(e) => setTyped((t) => ({ ...t, [input.key]: e.target.value }))}
                    >
                      {!known && value && <option value={value}>/{value}</option>}
                      {SKILL_GROUPS.map((g) => {
                        const list = skills.filter((sk) => (sk.source ?? 'installed') === g.source);
                        return list.length ? (
                          <optgroup key={g.source} label={g.label}>
                            {list.map((sk) => <option key={sk.id} value={sk.id}>/{sk.name}</option>)}
                          </optgroup>
                        ) : null;
                      })}
                    </select>
                    {input.hint && <span className="mt-1 block text-2xs text-ink-faint">{input.hint}</span>}
                  </label>
                );
              }
              return (
                <label key={input.key} className="block">
                  <span className="mb-1 block text-2xs font-semibold uppercase tracking-wide text-ink-faint">{input.label}</span>
                  <input
                    className="input w-full"
                    type={input.kind === 'time' ? 'time' : 'text'}
                    placeholder={input.placeholder}
                    value={typed[input.key] ?? templateInputDefault(input) ?? ''}
                    onChange={(e) => setTyped((t) => ({ ...t, [input.key]: e.target.value }))}
                    onBlur={() => setTouched((t) => new Set(t).add(input.key))}
                    aria-invalid={!!problem}
                  />
                  {problem ? (
                    <span className="mt-1 block text-2xs" style={{ color: STATUS.danger }}>{problem}</span>
                  ) : input.hint ? (
                    <span className="mt-1 block text-2xs text-ink-faint">{input.hint}</span>
                  ) : null}
                </label>
              );
            })}
          </section>
        )}

        <label className="mt-4 block">
          <span className="mb-1 block text-2xs font-semibold uppercase tracking-wide text-ink-faint">Notify me</span>
          <select className="input w-full" value={notify} onChange={(e) => setNotify(e.target.value as WorkflowNotify)}>
            {WORKFLOW_NOTIFY_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>

        <div className="mt-5 flex items-center gap-2">
          <button className="btn btn-ghost" title="Open it in the workflow editor to change the steps" onClick={() => onCustomize(seed())}>
            Customize
          </button>
          <button className="btn btn-ghost ml-auto" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => void turnOn()}>
            {busy ? 'Turning on…' : 'Turn on'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

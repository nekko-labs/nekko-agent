import React, { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_ORCHESTRATION, MODEL_CAPABILITIES, SUBAGENT_MODEL_CHOICES, getStrategy, isChatModel, isLocalProvider, subagentModelChoice,
} from '@nekko-agent/shared';
import type { AppSettings, ModelInfo, OrchestrationSettings, ProviderConfig, SubagentModelChoice } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { MODEL_LIST_TIMEOUT_MS, matchesModelQuery, modelRowLabel, withTimeout } from './agent-console/modelPickerInteractions.js';
import { CheckIcon } from '../icons.js';

/** What the Subagents row names: the saved model, else the auto choice. */
export function subagentModelLabel(o: OrchestrationSettings | undefined, models: Record<string, ModelInfo[] | null>): string {
  const route = o?.delegationRoute;
  if (route) return models[route.providerId]?.find((m) => m.id === route.modelId)?.name ?? route.modelId;
  const label = SUBAGENT_MODEL_CHOICES.find((c) => c.id === subagentModelChoice(o))!.label;
  const tier = o?.subagentTier;
  return tier && tier !== 'smaller' && o?.subagentModel !== 'inherit' ? `${label} · ${tier[0]!.toUpperCase()}${tier.slice(1)}` : label;
}

/** The settings patch for a pick: an auto choice clears a saved model, a model replaces the choice. */
export function subagentModelPatch(o: OrchestrationSettings | undefined, pick: SubagentModelChoice | { providerId: string; modelId: string }): OrchestrationSettings {
  const cur = o ?? DEFAULT_ORCHESTRATION;
  return typeof pick === 'string'
    ? { ...cur, subagentModel: pick, delegationRoute: undefined }
    : { ...cur, delegationRoute: pick };
}

/**
 * The model sub-agents run on, for every chat (#2487): Auto (a lighter model
 * than the chat's), its same-provider and prefer-local variants, the chat's
 * own model, or any chat model from every cloud and local provider, with a
 * search. It opens in place rather than in a popover of its own, because it
 * sits inside the model selector's popover. Hidden on Solo, where nothing
 * delegates.
 */
export function SubagentModelControl({ settingsOverride, update, defaultOpen = false, fusionAllowed }: {
  /** Settings to read instead of the store's (the Settings page passes its own copy). */
  settingsOverride?: AppSettings;
  /** Save a patch; defaults to the app's settings update. */
  update?: (patch: Partial<AppSettings>) => Promise<void>;
  defaultOpen?: boolean;
  /** Undefined on the global settings page. */
  fusionAllowed?: boolean;
}) {
  const storeSettings = useStore((s) => s.settings);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const settings = settingsOverride ?? storeSettings;
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const [byProvider, setByProvider] = useState<Record<string, ModelInfo[] | null>>({});
  const [error, setError] = useState<string | null>(null);
  const providers = useMemo(() => (settings?.providers ?? []).filter((p) => p.enabled !== false), [settings?.providers]);
  const orchestration = settings?.orchestration;
  const route = orchestration?.delegationRoute;

  // Every provider's chat models, each filling in as it answers; only while open
  // (and once for a saved model's name).
  useEffect(() => {
    if (!open && !route) return;
    let live = true;
    const wanted = open ? providers : providers.filter((p) => p.id === route?.providerId);
    for (const p of wanted) {
      if (byProvider[p.id] !== undefined) continue;
      void withTimeout(window.nekko.listModels(p.id), MODEL_LIST_TIMEOUT_MS)
        .then((m) => m.filter((x) => x.providerId === p.id && isChatModel(x)), () => null)
        .then((m) => { if (live) setByProvider((prev) => ({ ...prev, [p.id]: m })); });
    }
    return () => { live = false; };
    // byProvider is read only to skip what is already loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providers, route?.providerId]);

  if (!settings || !getStrategy((orchestration ?? DEFAULT_ORCHESTRATION).strategy).allowsSpawn) return null;

  const save = async (pick: SubagentModelChoice | { providerId: string; modelId: string }) => {
    setError(null);
    const patch = { orchestration: subagentModelPatch(orchestration, pick) };
    try {
      if (update) await update(patch);
      else { await window.nekko.updateSettings(patch); refreshSettings(); }
      setOpen(defaultOpen);
      setQuery('');
    } catch (e) { setError(`Could not save: ${String(e)}`); }
  };

  const q = query.trim().toLowerCase();
  const choice = route ? null : subagentModelChoice(orchestration);
  const choices = SUBAGENT_MODEL_CHOICES.filter((c) => !q || c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
  const column = (local: boolean) => providers.filter((p) => isLocalProvider(p.kind) === local);
  const pending = providers.some((p) => byProvider[p.id] === undefined);
  const providerRows = (p: ProviderConfig) => {
    const list = (byProvider[p.id] ?? []).filter((m) => !q || matchesModelQuery(m, q) || p.label.toLowerCase().includes(q));
    if (!list.length) return null;
    return <div key={p.id} role="group" aria-label={p.label}>
      <p className="truncate px-3 pb-1 pt-2 text-2xs text-ink-faint">{p.label}</p>
      {list.map((m) => {
        const selected = route?.providerId === p.id && route.modelId === m.id;
        const label = modelRowLabel(m, isLocalProvider(p.kind));
        return <button key={m.id} type="button" role="option" aria-selected={selected} className="quiet-row text-xs" title={`${label.name} · ${p.label}`} onClick={() => void save({ providerId: p.id, modelId: m.id })} data-subagent-model={`${p.id}::${m.id}`}>
          {m.loaded && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--success)' }} title="Loaded in memory" />}
          <span className={`min-w-0 flex-1 truncate ${selected ? 'text-accent' : 'text-ink'}`}>{label.name}</span>
          {selected && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />}
        </button>;
      })}
    </div>;
  };
  const section = (title: string, local: boolean) => {
    const rows = column(local).map(providerRows).filter(Boolean);
    if (!rows.length) return null;
    return <section aria-label={`${title} models`}><h4 className="quiet-group-label px-3 pt-2">{title}</h4>{rows}</section>;
  };
  const cloud = section('Cloud', false);
  const localSection = section('Local', true);

  return <div className="min-w-0 shrink-0" data-subagent-model-control>
    <button type="button" className="quiet-row text-xs" aria-expanded={open} aria-controls="subagent-model-list" onClick={() => { setOpen(!open); setQuery(''); }} title="The model sub-agents run on, in every chat">
      <span className="text-ink-faint">Subagents</span>
      <span className="min-w-0 flex-1 truncate text-right text-ink" data-subagent-model-label>{subagentModelLabel(orchestration, byProvider)}</span>
      <span className="ctl-caret shrink-0" aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
    {open && <div id="subagent-model-list" className="max-h-64 overflow-y-auto overscroll-contain px-1 pb-1">
      <label className="mb-2 flex flex-wrap items-center gap-2 px-3 text-xs">
        <span className="flex-1 text-ink-soft">Capability target</span>
        <select className="quiet-field w-auto max-w-[60%] shrink-0 text-xs" aria-label="Subagent capability target" value={orchestration?.subagentTier ?? 'smaller'} disabled={!!route || choice === 'inherit'} onChange={(e) => {
          const patch = { orchestration: { ...DEFAULT_ORCHESTRATION, ...orchestration, subagentTier: e.target.value as OrchestrationSettings['subagentTier'] } };
          setError(null);
          void (update ? update(patch) : window.nekko.updateSettings(patch).then(() => refreshSettings())).catch((e) => setError(`Could not save: ${String(e)}`));
        }}>
          <option value="smaller">Smaller than parent</option>
          {MODEL_CAPABILITIES.map((tier) => <option key={tier} value={tier}>{tier[0]!.toUpperCase() + tier.slice(1)}</option>)}
        </select>
        <span className="w-full text-2xs text-ink-faint">Target tier, then smaller; never above the parent.</span>
      </label>
      {fusionAllowed === false && <p className="mb-2 px-3 text-2xs text-ink-faint">Provider locked. Local preferences wait for Fusion; exact cross-provider picks are refused.</p>}
      <input className="quiet-field mb-1 w-full text-xs" placeholder="Search subagent models" aria-label="Filter subagent models" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus={!defaultOpen} />
      <div role="listbox" aria-label="Subagent model">
        {choices.map((c) => <button key={c.id} type="button" role="option" aria-selected={choice === c.id} className="quiet-row items-start text-xs" onClick={() => void save(c.id)} data-subagent-choice={c.id}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`font-medium ${choice === c.id ? 'text-accent' : 'text-ink'}`}>{c.id.startsWith('auto') ? `✨ ${c.label}` : c.label}{c.id === 'auto' && <span className="ml-2 text-2xs font-normal text-ink-faint">Default</span>}</span>
            <span className="text-2xs leading-snug text-ink-faint">{c.description}</span>
          </span>
          {choice === c.id && <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />}
        </button>)}
        {cloud}
        {localSection}
        {!cloud && !localSection && <p className="px-3 py-1 text-2xs text-ink-faint">{pending ? 'Loading models…' : q ? 'No models match.' : 'No chat models available.'}</p>}
      </div>
      <p className="px-3 pt-1 text-2xs text-ink-faint">Applies to every chat. A picked model never falls back.</p>
      {error && <p role="alert" className="px-3 pt-1 text-2xs" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>}
  </div>;
}

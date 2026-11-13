import React, { useEffect, useState } from 'react';
import type { AppSettings, FusionStrategy, ModelCapability, ModelInfo } from '@nekko-agent/shared';
import { FUSION_STRATEGIES, MODEL_CAPABILITIES, fusionStrategy, modelCapability, isChatModel } from '@nekko-agent/shared';
import { MODEL_LIST_TIMEOUT_MS, withTimeout } from './agent-console/modelPickerInteractions.js';

export function FusionStrategyControl({ value, onChange }: { value: FusionStrategy; onChange: (value: FusionStrategy) => void }) {
  return <label className="flex flex-wrap items-center gap-2 text-xs">
    <span className="flex-1 text-ink-soft">Fusion strategy</span>
    <select aria-label="Fusion strategy" className="quiet-field w-auto max-w-[55%] shrink-0 text-xs" value={value} onChange={(e) => onChange(e.target.value as FusionStrategy)}>
      {FUSION_STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </select>
    <span className="w-full text-2xs text-ink-faint">{FUSION_STRATEGIES.find((s) => s.id === value)?.description} Rules only; no extra model call.</span>
  </label>;
}

/** Ranking never grants permission: each chat still opts into Fusion separately. */
export function FusionSettingsControl({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => Promise<void> }) {
  const [catalogs, setCatalogs] = useState<Record<string, ModelInfo[] | null>>({});
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let live = true;
    for (const provider of settings.providers.filter((p) => p.enabled !== false)) {
      void withTimeout(window.nekko.listModels(provider.id), MODEL_LIST_TIMEOUT_MS)
        .then((models) => { if (live) setCatalogs((c) => ({ ...c, [provider.id]: models })); })
        .catch(() => { if (live) setCatalogs((c) => ({ ...c, [provider.id]: null })); });
    }
    return () => { live = false; };
  }, [open, settings.providers]);
  const save = (fusion: AppSettings['fusion']) => { setError(''); void update({ fusion }).catch((e) => setError(String(e))); };
  const classify = (model: ModelInfo, tier: string) => {
    const modelTiers = { ...settings.fusion?.modelTiers };
    const key = `${model.providerId}::${model.id}`;
    if (tier === 'suggested') delete modelTiers[key]; else modelTiers[key] = tier as ModelCapability;
    save({ ...settings.fusion, modelTiers });
  };
  return <section className="min-w-0" data-fusion-settings>
    <h3 className="text-sm font-medium">Fusion routing</h3>
    <p className="mb-3 mt-(--q-tight) text-xs text-ink-faint">These preferences apply only when a chat enables Fusion. Auto alone stays on its selected provider, including subagents.</p>
    <FusionStrategyControl value={fusionStrategy(settings.fusion)} onChange={(strategy) => save({ ...settings.fusion, strategy })} />
    <button type="button" className="quiet-row mt-3 text-xs" aria-expanded={open} onClick={() => setOpen(!open)}>Model capability tiers <span aria-hidden="true">{open ? '▾' : '▸'}</span></button>
    {open && <div className="mt-2 space-y-3" data-model-tier-editor>
      <p className="text-2xs text-ink-faint">Relative capability, not file size. Suggestions are heuristics, not benchmark guarantees. Unknown models need a classification for tier routing.</p>
      <input className="quiet-field w-full text-xs" aria-label="Search model tiers" placeholder="Search models or providers" value={query} onChange={(e) => setQuery(e.target.value)} />
      {settings.providers.filter((p) => p.enabled !== false).map((provider) => <div key={provider.id}>
        <p className="mb-1 text-2xs font-medium text-ink-soft">{provider.label}</p>
        {catalogs[provider.id] === undefined ? <p className="text-2xs text-ink-faint">Loading models…</p>
          : catalogs[provider.id] === null ? <p className="text-2xs text-ink-faint">Could not load this catalog. Close and reopen to retry.</p>
          : catalogs[provider.id]?.filter(isChatModel).filter((m) => `${provider.label} ${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase())).map((model) => {
            const capability = modelCapability(model, settings.fusion?.modelTiers);
            return <label key={model.id} className="flex min-w-0 items-center gap-2 py-2 text-xs">
              <span className="min-w-0 flex-1"><span className="block truncate">{model.name || model.id}</span><span className="block text-2xs text-ink-faint">{capability.source === 'user' ? 'Your classification' : capability.source === 'suggested' ? `Suggested · ${capability.tier}` : 'Unclassified'}</span></span>
              <select className="quiet-field w-auto max-w-[55%] shrink-0 text-xs" aria-label={`Capability for ${provider.label}: ${model.name || model.id}`} value={capability.source === 'user' ? capability.tier : 'suggested'} onChange={(e) => classify(model, e.target.value)}>
                <option value="suggested">{capability.source === 'user' ? 'Reset to suggested' : capability.tier ? `Suggested · ${capability.tier}` : 'Unclassified'}</option>
                {MODEL_CAPABILITIES.map((tier) => <option key={tier} value={tier}>{tier[0]!.toUpperCase() + tier.slice(1)}</option>)}
              </select>
            </label>;
          })}
      </div>)}
    </div>}
    {error && <p role="alert" className="mt-2 text-xs text-danger-text">{error}</p>}
  </section>;
}

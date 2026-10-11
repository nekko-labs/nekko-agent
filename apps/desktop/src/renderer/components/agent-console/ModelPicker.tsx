import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pickerPlacement } from './pickerPlacement.js';
import { filteredModelGroups, isModelPickerEscape, nextFavoriteModels, shouldDismissModelPickerPointer } from './modelPickerInteractions.js';
import type { AutoQuality, ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import {
  AUTO_MODEL_ID, AUTO_QUALITIES, AUTO_QUALITY_META, blockLabel, formatModelPriceLabel,
  isLocalProvider, modelPricing, resolveModelAvailability,
} from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { useAllProviderLimits } from '../../useLimits.js';
import { ContextMenu, ContextAction } from '../ContextMenu.js';
import { StarIcon } from '../../icons.js';

/** How long one provider's model list may take before it is shown as unreachable. */
export const MODEL_LIST_TIMEOUT_MS = 6000;

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Provider + model as one legible control (instead of two microscopic selects):
 * a chip naming the current model that opens a flat picker of every provider's
 * models, grouped by provider, starred on top, Auto first.
 */
export function ModelPicker({
  providers,
  providerId,
  models,
  modelId,
  open,
  onOpenChange,
  needsChoice,
  unavailableModel,
  onProvider,
  onModel,
  expanded = false,
  recent = [],
  readOnly = false,
}: {
  providers: ProviderConfig[];
  providerId: string | null;
  models: ModelInfo[];
  modelId: string | null;
  /** Open state is owned by the pane so the "choose a model" nudges can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** No model picked yet: the chip asks for one instead of reading as a setting. */
  needsChoice?: boolean;
  /** The chat's saved model id when its provider no longer offers it: the chip names it and marks it unavailable. */
  unavailableModel?: string | null;
  onProvider: (id: string) => void;
  onModel: (providerId: string, id: string) => void;
  /** Render the list inline in an empty conversation instead of in a popover. */
  expanded?: boolean;
  recent?: string[];
  /** Allow model selection without changing favorites or default settings. */
  readOnly?: boolean;
}) {
  const [menu, setMenu] = useState<{x: number; y: number; pid: string; mid: string} | null>(null);
  const settings = useStore((s) => s.settings);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const setOpen = (next: boolean) => onOpenChange(next);
  const [query, setQuery] = useState('');
  // Models per provider, fetched when the menu opens so the list covers every
  // provider (the `models` prop only holds the active provider's).
  const [byProvider, setByProvider] = useState<Record<string, ModelInfo[] | null>>({});
  // Live usage limits for every signed-in provider, so a model that can't run
  // right now can say so instead of quietly failing on send.
  const limitsByToken = useAllProviderLimits(providers, open);
  const ref = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || expanded) return;
    const position = () => {
      if (ref.current) setPlacement(pickerPlacement(ref.current.getBoundingClientRect(), window.innerWidth, window.innerHeight));
    };
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    const observer = new ResizeObserver(position);
    if (ref.current) observer.observe(ref.current);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      observer.disconnect();
    };
  }, [open, expanded]);

  useEffect(() => {
    if (!open || expanded) return;
    const onDoc = (e: MouseEvent) => {
      if (shouldDismissModelPickerPointer(e.target, ref.current, popupRef.current)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (isModelPickerEscape(e)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, expanded]);

  // Each provider fills in as it answers. Waiting for all of them let one
  // unreachable server (a LAN box that is off) hold every other list, the
  // default model included, at "loading…" for as long as its connect hung.
  useEffect(() => {
    if (!open && !expanded) return;
    let live = true;
    for (const p of providers) {
      void withTimeout(window.nekko.listModels(p.id), MODEL_LIST_TIMEOUT_MS)
        .then((m) => m, () => null)
        .then((m) => { if (live) setByProvider((prev) => ({ ...prev, [p.id]: m })); });
    }
    return () => { live = false; };
  }, [open, expanded, providers]);
  const pending = providers.some((p) => byProvider[p.id] === undefined && p.id !== providerId);

  const favSet = new Set(settings?.favoriteModels ?? []);
  const toggleFavorite = async (key: string) => {
    const next = nextFavoriteModels(settings?.favoriteModels, key);
    await window.nekko.updateSettings({ favoriteModels: next });
    refreshSettings();
  };

  const modelsOf = (pid: string): ModelInfo[] =>
    byProvider[pid] ?? (pid === providerId ? models : []);
  const q = query.trim().toLowerCase();
  const groups = filteredModelGroups(providers, modelsOf, query);
  const starred = groups.flatMap((g) =>
    g.models
      .filter((m) => favSet.has(`${g.provider.id}::${m.id}`) && !recent.includes(`${g.provider.id}::${m.id}`))
      .map((m) => ({ provider: g.provider, model: m })),
  );
  const recentModels = recent.map((key) => {
    const group = groups.find((g) => key.startsWith(`${g.provider.id}::`));
    const model = group?.models.find((m) => key === `${group.provider.id}::${m.id}`);
    return group && model ? { provider: group.provider, model } : null;
  }).filter((entry): entry is { provider: ProviderConfig; model: ModelInfo } => !!entry).slice(0, 5);
  const total = providers.reduce((n, p) => n + modelsOf(p.id).length, 0);
  const defaultProvider = providers.find(p => p.id === settings?.defaultProviderId);
  const defaultModel = defaultProvider ? modelsOf(defaultProvider.id).find(m => m.id === settings?.defaultModelId) : undefined;
  const defaultKey = settings?.defaultProviderId && settings?.defaultModelId ? settings.defaultProviderId + '::' + settings.defaultModelId : null;
  // Absence is only authoritative after this provider's catalog has loaded.
  const defaultStatus = !defaultProvider ? 'unavailable'
    : byProvider[defaultProvider.id] === null ? 'catalog could not load'
    : byProvider[defaultProvider.id] === undefined && defaultProvider.id !== providerId ? 'loading…'
    : 'unavailable';
  const pinnedKeys = new Set([...recentModels, ...starred].map((s) => `${s.provider.id}::${s.model.id}`));

  if (defaultKey) pinnedKeys.add(defaultKey);
  const providerLabel = providers.find((p) => p.id === providerId)?.label ?? 'No provider';
  const currentName =
    modelId === AUTO_MODEL_ID ? '✨ Auto' : models.find((m) => m.id === modelId)?.name ?? 'No model';

  const pick = (pid: string, mid: string) => {
    if (pid !== providerId) onProvider(pid);
    onModel(pid, mid);
    if (!expanded) setOpen(false);
  };

  /**
   * Why a model can't be run, or null when it can. Provider-agnostic: the
   * catalog's own claim (a model gated behind a bigger plan) combined with the
   * live usage windows for whichever account this provider signs in as.
   */
  const availabilityOf = (p: ProviderConfig, m: ModelInfo) =>
    resolveModelAvailability({ model: m, provider: p, limits: p.tokenKey ? limitsByToken[p.tokenKey] : undefined });

  const row = (p: ProviderConfig, m: ModelInfo, showProvider: boolean) => {
    const key = `${p.id}::${m.id}`;
    const fav = favSet.has(key);
    const selected = p.id === providerId && modelId === m.id;
    const price = formatModelPriceLabel({ modelId: m.id, auth: p.auth, isLocal: isLocalProvider(p.kind), pricing: modelPricing(m) });
    // A blocked model stays in the list and says why. Hiding it makes a model
    // that exists look like one the app never heard of.
    const availability = availabilityOf(p, m);
    const blocked = availability.status === 'blocked';
    const why = availability.detail ?? blockLabel(availability);
    // The engine sends the file's path as a detail, so a local model's subtext
    // is where it lives rather than a price it does not have.
    const sub = m.details?.path;
    return (
      <div
        key={key}
        onContextMenu={readOnly ? undefined : (e) => { e.preventDefault(); setMenu({x:e.clientX,y:e.clientY,pid:p.id,mid:m.id}); }}
        className={`flex w-full items-center rounded-lg hover:bg-surface-2 ${selected ? 'text-accent' : ''}`}
      >
        <button
          role="option"
          aria-selected={selected}
          aria-disabled={blocked}
          disabled={blocked}
          className={`flex min-w-0 flex-1 flex-col px-2.5 py-1.5 text-left ${blocked ? 'cursor-not-allowed' : ''}`}
          onClick={() => pick(p.id, m.id)}
          title={blocked ? `${m.name} · ${why}` : sub ? `${m.name} · ${sub}` : m.name}
        >
          <div className="flex w-full items-center gap-2">
            {key === defaultKey && <span className="text-[10px] text-accent">Default</span>}
            {m.loaded && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: 'var(--success)' }}
                title="Loaded in memory"
              />
            )}
            <span className={`min-w-0 truncate text-[12.5px] font-medium leading-tight ${blocked ? 'text-ink-faint' : ''}`}>{m.name}</span>
            {blocked && (
              <span
                className="shrink-0 rounded-sm px-1 py-0.5 text-[10px] font-semibold leading-none"
                style={{
                  background: 'color-mix(in srgb, var(--danger) 14%, transparent)',
                  color: 'var(--danger)',
                }}
              >
                {blockLabel(availability)}
              </span>
            )}
            {showProvider && <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{p.label}</span>}
          </div>
          <span
            className={`truncate text-[10px] text-ink-faint ${sub ? 'font-mono' : ''}`}
            title={blocked ? why : sub ?? 'Estimated list price per 1M tokens'}
          >
            {blocked ? why : sub ?? price}
          </span>
        </button>
        {!readOnly && <button
          className={`shrink-0 rounded-sm p-1.5 ${fav ? 'text-accent' : 'text-ink-faint hover:text-ink'}`}
          title={fav ? 'Unstar' : 'Star (pin to the top of this list)'}
          aria-label={fav ? `Unstar ${m.name}` : `Star ${m.name}`}
          aria-pressed={fav}
          onClick={() => toggleFavorite(key)}
        >
          <StarIcon className="h-3.5 w-3.5" filled={fav} />
        </button>}
      </div>
    );
  };

  const header = (label: string) => (
    <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
  );

  const popup = (
        <div ref={popupRef} style={expanded ? undefined : placement} className={expanded ? 'card flex h-full min-h-0 w-full flex-col p-2 text-left' : 'card fixed z-50 flex flex-col p-1.5 shadow-lg'}>
          {/* Wide enough for a local model's path to read under its name; still
              capped so it never runs off a narrow pane. */}
          {(expanded || total > 8) && (
            <input
              className="input mb-1 rounded-lg px-2.5 py-1 text-[12px]"
              placeholder="Filter models…"
              value={query}
              autoFocus={!expanded}
              aria-label="Filter models"
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Model">
            {defaultKey && !q && (defaultProvider && defaultModel ? row(defaultProvider, defaultModel, true) : <button role="option" disabled aria-disabled="true" className="w-full px-2.5 py-2 text-left text-[12px] text-ink-faint">{settings?.defaultModelId} <span className="text-[10px]">Default · {defaultStatus}</span></button>)}
            {providers.length === 0 && <p className="px-2.5 py-1.5 text-[11px] text-ink-faint">No provider configured.</p>}
            {providers.length > 0 && groups.length === 0 && (
              <p className="px-2.5 py-1.5 text-[11px] text-ink-faint">{q ? 'No models match.' : pending ? 'Loading models…' : 'No models available.'}</p>
            )}
            {total > 1 && !q && (
              <button
                role="option"
                aria-selected={modelId === AUTO_MODEL_ID}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2 ${modelId === AUTO_MODEL_ID ? 'text-accent' : ''}`}
                onClick={() => { onModel(providerId ?? '', AUTO_MODEL_ID); setOpen(false); }}
                title="Nekko Agent picks the best model for each message"
              >
                ✨ Auto <span className="text-[11px] text-ink-faint">(pick best)</span>
              </button>
            )}
            {recentModels.length > 0 && !q && <>{header('Recent')}{recentModels.filter(s => `${s.provider.id}::${s.model.id}` !== defaultKey).map((s) => row(s.provider, s.model, true))}</>}
            {starred.length > 0 && !q && (
              <>
                {header('★ Starred')}
                {starred.filter(s => `${s.provider.id}::${s.model.id}` !== defaultKey).map((s) => row(s.provider, s.model, true))}
              </>
            )}
            {groups.map((g) => {
              const remaining = q ? g.models : g.models.filter((m) => !pinnedKeys.has(`${g.provider.id}::${m.id}`));
              if (!remaining.length) return null;
              // A local provider can serve models out of several folders; when
              // the rows say where they live, group them under that heading.
              const locs = [...new Set(remaining.map((m) => m.details?.location ?? ''))];
              const byLoc =
                locs.length > 1
                  ? locs.map((loc) => ({ loc, models: remaining.filter((m) => (m.details?.location ?? '') === loc) }))
                  : [{ loc: '', models: remaining }];
              return (
                <React.Fragment key={g.provider.id}>
                  {header(g.provider.label)}
                  {byLoc.map(({ loc, models: ms }) => (
                    <React.Fragment key={loc || '_'}>
                      {loc && (
                        <p className="truncate px-4 pb-0.5 pt-1 text-[10px] italic text-ink-faint" title={loc}>
                          {loc}
                        </p>
                      )}
                      {ms.map((m) => row(g.provider, m, false))}
                    </React.Fragment>
                  ))}
                </React.Fragment>
              );
            })}
          </div>
        </div>
  );

  return (
    <div ref={ref} className={expanded ? 'h-full min-h-0 w-full min-w-0' : 'relative min-w-0 max-w-[240px]'}>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}><ContextAction onClick={() => { void window.nekko.updateSettings({defaultProviderId:menu.pid,defaultModelId:menu.mid}).then(() => refreshSettings()).catch(e => useStore.getState().pushToast('error', String(e))); setMenu(null); }}>Set as default</ContextAction></ContextMenu>}
      {!expanded && <button
        className="ctl-menu max-w-full"
        style={unavailableModel ? { borderColor: 'var(--warning)', color: 'var(--warning)' } : needsChoice ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
        data-model-unavailable={unavailableModel ? true : undefined}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={unavailableModel ? `${unavailableModel} is not available right now. Pick a model again.` : needsChoice ? 'This chat has no model yet - pick one' : `Model: ${currentName} · ${providerLabel}`}
      >
        <span className="min-w-0 truncate">{unavailableModel ? <><s className="opacity-80">{unavailableModel}</s> · unavailable</> : needsChoice ? 'Choose a model' : currentName}</span>
        <span className="ctl-menu-label hidden min-w-0 truncate md:inline">· {providerLabel}</span>
        <span className="ctl-caret">▾</span>
      </button>}
      {/* Portalled out of the pane's overflow clipping and clamped to the viewport. */}
      {(open || expanded) && (
        expanded ? popup : createPortal(popup, document.body)
      )}
    </div>
  );
}

/**
 * How hard ✨ Auto leans on capability for this chat. Sits beside the model chip
 * and only while Auto is selected, so the strip doesn't carry a control that
 * does nothing.
 */
export function AutoQualityMenu({
  quality,
  onPick,
  followCapacity,
  onFollowCapacity,
}: {
  quality: AutoQuality;
  onPick: (q: AutoQuality) => void;
  /** Whether Auto may move a turn to an equivalent model elsewhere. */
  followCapacity?: boolean;
  onFollowCapacity?: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        className="ctl-menu whitespace-nowrap"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Auto profile: ${AUTO_QUALITY_META[quality].label} - ${AUTO_QUALITY_META[quality].description}`}
      >
        <span className="ctl-menu-label">Auto</span>
        {AUTO_QUALITY_META[quality].label}
        <span className="ctl-caret">▾</span>
      </button>
      {open && (
        <div className="card absolute bottom-8 left-0 z-40 w-60 p-1.5 shadow-lg" role="menu">
          {AUTO_QUALITIES.map((q) => (
            <button
              key={q}
              role="menuitemradio"
              aria-checked={quality === q}
              className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${quality === q ? 'text-accent' : ''}`}
              onClick={() => { onPick(q); setOpen(false); }}
            >
              <span className="text-[13px] font-medium">{AUTO_QUALITY_META[q].label}</span>
              <span className="text-[11px] text-ink-faint">{AUTO_QUALITY_META[q].description}</span>
            </button>
          ))}
          {onFollowCapacity && (
            <button
              role="menuitemcheckbox"
              aria-checked={!!followCapacity}
              className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
              onClick={() => onFollowCapacity(!followCapacity)}
            >
              <span
                className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${followCapacity ? 'border-accent bg-accent text-white' : 'border-line'}`}
                aria-hidden
              >
                {followCapacity ? '✓' : ''}
              </span>
              <span>
                <span className="block text-[13px] font-medium">Follow capacity &amp; cost</span>
                <span className="block text-[11px] leading-snug text-ink-faint">
                  When this provider is spent or an equivalent model elsewhere is much cheaper, run the turn there and say why. Never a downgrade.
                </span>
              </span>
            </button>
          )}
          <p className="border-t border-line px-2.5 pb-0.5 pt-1.5 text-[10px] text-ink-faint">Applies to this chat only.</p>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pickerPlacement } from './pickerPlacement.js';
import { MODEL_LIST_TIMEOUT_MS, filteredModelGroups, isModelPickerEscape, modelRowLabel, nextFavoriteModels, shouldDismissModelPickerPointer, withTimeout } from './modelPickerInteractions.js';
import type { AutoQuality, ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import {
  AUTO_MODEL_ID, AUTO_QUALITIES, AUTO_QUALITY_META, blockLabel, claudeCreditsAvailable, claudePlanNote, claudePlanUsageNotice, formatModelPriceLabel,
  isLocalProvider, limitsKeyFor, modelPricing, resolveModelAvailability, shortModelName,
} from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store.js';
import { useProviderLimitsPortfolio } from '../../useLimits.js';
import { accountFamilies, identityLine, useAccountIdentities, type AccountFamily, type AccountIdentity } from '../../providerAccounts.js';
import { ProviderUsageMeters } from './ProviderUsageMeters.js';
import { ContextMenu, ContextAction } from '../ContextMenu.js';
import { Group, QuietTabs } from '../primitives/Quiet.js';
import { CheckIcon, CloudIcon, GridIcon, LaptopIcon, RouteIcon, StarIcon } from '../../icons.js';

/**
 * Provider + model as one legible control: a chip naming the current model
 * (and, when its family has several, the account) that opens a picker grouped
 * by family. A family with several accounts (a personal Claude plan and an
 * organization seat on the same login, an API key) shows them as tabs; picking
 * one lists that account's models, and on the chat's own family it moves the
 * chat to the same model there in one click. Quiet surfaces: no boxes inside
 * the popover, groups told apart by space and type (docs/design-system.md).
 */
export function ModelPicker({
  providers: allProviders,
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
  allowAuto = true,
  filterProviders,
  placeholder,
  resolvedModelId,
  footer,
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
  /** Offer ✨ Auto (a chat picks per turn; a workflow step cannot). */
  allowAuto?: boolean;
  /** Only list providers this accepts (a local-only workflow lists local servers). */
  filterProviders?: (p: ProviderConfig) => boolean;
  /** Chip text while no model is chosen (an inherited model), instead of "No model". */
  placeholder?: string;
  /**
   * The specific model id Claude Code reported in its `system/init` for this
   * chat (`session.claudeCodeContext.model`). When the chat was pinned to
   * `opus`/`sonnet`/`haiku`, Claude Code resolves that to the plan's current
   * default, so the chip reads the concrete version.
   */
  resolvedModelId?: string;
  /** Under the list, for what belongs with the model (such as Auto quality). */
  footer?: React.ReactNode;
}) {
  // A provider switched off on the Models page is neither listed nor contacted.
  const providers = useMemo(() => allProviders.filter((p) => p.enabled !== false && (!filterProviders || filterProviders(p))), [allProviders, filterProviders]);
  const [menu, setMenu] = useState<{x: number; y: number; pid: string; mid: string} | null>(null);
  // Only what the picker shows: the whole settings object is replaced on every save.
  const settings = useStore(useShallow((s) => s.settings && { favoriteModels: s.settings.favoriteModels, defaultProviderId: s.settings.defaultProviderId, defaultModelId: s.settings.defaultModelId }));
  const refreshSettings = useStore((s) => s.refreshSettings);
  const setOpen = (next: boolean) => onOpenChange(next);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'fusion' | 'cloud' | 'local'>('all');
  // Which account each family is showing, when the user picked one to look at.
  const [viewing, setViewing] = useState<Record<string, string>>({});
  useEffect(() => { if (!open) setViewing({}); }, [open]);
  // Models per provider, fetched when the menu opens so the list covers every
  // provider (the `models` prop only holds the active provider's).
  const [byProvider, setByProvider] = useState<Record<string, ModelInfo[] | null>>({});
  // Live usage limits for every signed-in provider, so a model that can't run
  // right now can say so instead of quietly failing on send.
  const { byToken: limitsByToken, answered } = useProviderLimitsPortfolio(providers, open || expanded);
  const limitsOf = (p: ProviderConfig) => limitsByToken[limitsKeyFor(p) ?? ''];
  // Who each account is (Personal · Max, Acme · Team, an API key's name).
  const identities = useAccountIdentities(providers, open || expanded);
  const idOf = (p: ProviderConfig): AccountIdentity => identities[p.id] ?? { name: p.label };
  const families = useMemo(() => accountFamilies(providers), [providers]);
  const familyOfProvider = (p: ProviderConfig) => families.find((f) => f.providers.includes(p));
  const multiAccount = (p: ProviderConfig) => (familyOfProvider(p)?.providers.length ?? 0) > 1;
  /** "Claude · Acme" when the family has several accounts, else the family alone. */
  const accountLabel = (p: ProviderConfig) => {
    const f = familyOfProvider(p);
    return f && f.providers.length > 1 ? `${f.name} · ${idOf(p).name}` : (f?.name ?? p.label);
  };
  const nameOf = (p: ProviderConfig) => {
    const email = idOf(p).email;
    return email ? `${accountLabel(p)} · ${email}` : accountLabel(p);
  };
  // Under 600px (a phone, a folded screen) Cloud and Local stack in one scroll instead of squeezing side by side.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth < 600);
  useEffect(() => {
    if (!open && !expanded) return;
    const measure = () => setNarrow(window.innerWidth < 600);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, expanded]);
  const bothKinds = scope === 'all' && providers.some((p) => isLocalProvider(p.kind)) && providers.some((p) => !isLocalProvider(p.kind));
  const twoColumns = bothKinds && !narrow;
  const ref = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || expanded) return;
    const position = () => {
      if (ref.current) setPlacement(pickerPlacement(ref.current.getBoundingClientRect(), window.innerWidth, window.innerHeight, twoColumns ? 640 : 416));
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
  }, [open, expanded, twoColumns]);

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
  const visibleProviders = providers.filter((p) => scope === 'all' || (scope !== 'fusion' && isLocalProvider(p.kind) === (scope === 'local')));
  const groups = filteredModelGroups(visibleProviders, modelsOf, query);
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
  const defaultProvider = visibleProviders.find(p => p.id === settings?.defaultProviderId);
  const defaultModel = defaultProvider ? modelsOf(defaultProvider.id).find(m => m.id === settings?.defaultModelId) : undefined;
  const defaultKey = settings?.defaultProviderId && settings?.defaultModelId ? settings.defaultProviderId + '::' + settings.defaultModelId : null;
  // Absence is only authoritative after this provider's catalog has loaded.
  const defaultStatus = !defaultProvider ? 'unavailable'
    : byProvider[defaultProvider.id] === null ? 'catalog could not load'
    : byProvider[defaultProvider.id] === undefined && defaultProvider.id !== providerId ? 'loading…'
    : 'unavailable';
  const pinnedKeys = new Set([...recentModels, ...starred].map((s) => `${s.provider.id}::${s.model.id}`));

  // The default belongs in its real provider group, even when recent or starred.
  if (defaultKey) pinnedKeys.delete(defaultKey);
  // Named from every provider: a filtered-out selection still says what it is.
  const currentProvider = allProviders.find((p) => p.id === providerId);
  const providerLabel = currentProvider ? nameOf(currentProvider) : 'No provider';
  // `models` is the previous provider's until the new list lands; the picker may already hold it.
  const currentModel = models.find((m) => m.id === modelId) ?? (providerId ? byProvider[providerId]?.find((m) => m.id === modelId) : undefined);
  // A Claude subscription chat gets its model picked by Claude Code: once it
  // has reported which version it resolved the chip reads that instead of the alias.
  const claudeCodeResolved = currentProvider?.kind === 'claude-code' && resolvedModelId
    ? shortModelName(resolvedModelId)
    : null;
  const currentName =
    modelId === AUTO_MODEL_ID ? '✨ Auto'
      : claudeCodeResolved
        ? claudeCodeResolved
        : currentModel ? modelRowLabel(currentModel, !!currentProvider && isLocalProvider(currentProvider.kind)).name
        : modelId ?? 'No model';
  // The account rides along in the chip only when it is ambiguous.
  const chipAccount = currentProvider && modelId !== AUTO_MODEL_ID && multiAccount(currentProvider) ? idOf(currentProvider).name : null;

  const pick = (pid: string, mid: string) => {
    if (pid !== providerId) onProvider(pid);
    onModel(pid, mid);
    if (!expanded) setOpen(false);
  };

  /** The account a family is showing: the one picked to look at, else the chat's, else the first. */
  const shownAccount = (f: AccountFamily): ProviderConfig =>
    f.providers.find((p) => p.id === viewing[f.id]) ?? f.providers.find((p) => p.id === providerId) ?? f.providers[0];
  /**
   * An account tab. On the chat's own family it moves the chat to the same
   * model on that account when the account offers it (one click to switch);
   * otherwise, and on any other family, it shows that account's models.
   */
  const chooseAccount = (f: AccountFamily, p: ProviderConfig) => {
    setViewing((prev) => ({ ...prev, [f.id]: p.id }));
    const ownFamily = !!currentProvider && f.providers.includes(currentProvider);
    if (ownFamily && p.id !== providerId && modelId && modelId !== AUTO_MODEL_ID && modelsOf(p.id).some((m) => m.id === modelId)) pick(p.id, modelId);
  };
  const accountTabTitle = (f: AccountFamily, p: ProviderConfig) => {
    const id = idOf(p);
    const who = [identityLine(id), id.email !== id.name ? id.email : ''].filter(Boolean).join(' · ');
    if (p.id === providerId) return `${who} (this chat)`;
    const ownFamily = !!currentProvider && f.providers.includes(currentProvider);
    const list = byProvider[p.id];
    if (ownFamily && modelId && modelId !== AUTO_MODEL_ID && list?.some((m) => m.id === modelId)) return `${who}: move this chat to ${currentName} here`;
    if (ownFamily && modelId && modelId !== AUTO_MODEL_ID && list) return `${who}: does not offer ${currentName}, pick one of its models`;
    return `${who}: show its models`;
  };

  /**
   * Why a model can't be run, or null when it can. Provider-agnostic: the
   * catalog's own claim (a model gated behind a bigger plan) combined with the
   * live usage windows for whichever account this provider signs in as.
   */
  const availabilityOf = (p: ProviderConfig, m: ModelInfo) =>
    resolveModelAvailability({ model: m, provider: p, limits: limitsOf(p) });

  /** `account`: name the row's account (search across a family's accounts); `family`: and its family too (pinned rows). */
  const row = (p: ProviderConfig, m: ModelInfo, showAccount: false | 'account' | 'family') => {
    const key = `${p.id}::${m.id}`;
    const fav = favSet.has(key);
    const selected = p.id === providerId && modelId === m.id;
    const local = isLocalProvider(p.kind);
    const price = formatModelPriceLabel({ modelId: m.id, auth: p.auth, isLocal: local, pricing: modelPricing(m) });
    // A blocked model stays in the list and says why. Hiding it makes a model
    // that exists look like one the app never heard of.
    const availability = availabilityOf(p, m);
    // What this Claude plan includes for the model (Fable on Pro runs on
    // credits, on Max up to half the week): said, never enforced. A Fable
    // window Claude Code reports spent, on an account with credits, still runs
    // (on credits), so it is not "Limit reached".
    const plan = p.kind === 'claude-code' ? idOf(p).plan : undefined;
    const now = Date.now();
    const planUsage = plan ? claudePlanUsageNotice({ modelId: m.id, subscriptionType: plan, limits: limitsOf(p), now }) : null;
    const onCredits = availability.reason === 'rate-limited' && planUsage?.kind === 'on-credits' && claudeCreditsAvailable(limitsOf(p));
    const blocked = availability.status === 'blocked' && !onCredits;
    const why = availability.detail ?? blockLabel(availability);
    // A local model's detail is where it lives (a path-like id splits into a
    // short name and its folder); a cloud model's is its price.
    const label = modelRowLabel(m, local);
    const claudeVersion = p.kind === 'claude-code' && selected && resolvedModelId ? shortModelName(resolvedModelId) : null;
    const detail = blocked ? why : label.sub;
    const planNote = plan ? claudePlanNote(m.id, plan, now) : null;
    const planLabel = onCredits ? 'Uses usage credits' : planNote?.label ?? null;
    const meta = showAccount === 'family' ? accountLabel(p) : showAccount === 'account' ? idOf(p).name : key === defaultKey ? null : (p.kind === 'claude-code' ? planLabel : (m.availability?.detail ?? price));
    const tip = p.kind === 'claude-code'
      ? [claudeVersion ? `Currently ${claudeVersion} · Claude Code chooses the version` : 'Claude Code chooses the version when the chat starts', onCredits ? planUsage?.text : planNote?.detail].filter(Boolean).join('\n')
      : [label.name, detail ?? meta].filter(Boolean).join(' · ');
    return (
      <div
        key={key}
        onContextMenu={readOnly ? undefined : (e) => { e.preventDefault(); setMenu({x:e.clientX,y:e.clientY,pid:p.id,mid:m.id}); }}
        className="group/row flex w-full min-w-0 items-center rounded-lg"
        data-model-row
      >
        <button
          type="button"
          role="option"
          aria-selected={selected}
          aria-disabled={blocked}
          disabled={blocked}
          className="quiet-row min-w-0 flex-1"
          onClick={() => pick(p.id, m.id)}
          title={tip}
        >
          {m.loaded && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--success)' }} title="Loaded in memory" />}
          <span className={`flex min-w-0 flex-1 ${detail && local ? 'flex-col' : 'items-baseline gap-2'}`}>
            <span className={`min-w-0 truncate text-xs font-medium leading-tight ${blocked ? 'text-ink-faint' : selected ? 'text-accent' : 'text-ink'}`} data-model-name>{claudeVersion ? `${label.name} (${claudeVersion})` : label.name}</span>
            {detail && <span className={`min-w-0 truncate text-2xs ${blocked ? '' : 'text-ink-faint'} ${label.sub && !blocked ? 'font-mono' : ''}`} style={blocked ? { color: 'var(--danger)' } : undefined} title={detail}>{blocked ? `${blockLabel(availability)} · ${why}` : detail}</span>}
          </span>
          {key === defaultKey && <span className="shrink-0 text-2xs text-accent">Default</span>}
          {meta && <span className="max-w-[45%] shrink truncate text-2xs text-ink-faint" title={showAccount ? nameOf(p) : meta}>{meta}</span>}
          {selected && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />}
        </button>
        {!readOnly && <button
          type="button"
          className={`shrink-0 rounded-md p-2 ${fav ? 'text-accent' : 'text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100 touch:opacity-100'}`}
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

  /** One provider's rows (a local server's split by folder), with its default even when missing. */
  const providerRows = (p: ProviderConfig, showAccount: false | 'account' = false) => {
    const g = groups.find((group) => group.provider.id === p.id) ?? { provider: p, models: [] };
    const remaining = q ? g.models : g.models.filter((m) => (favSet.has(`${p.id}::${m.id}`) || !pinnedKeys.has(`${p.id}::${m.id}`)));
    const missingDefault = defaultProvider?.id === p.id && !defaultModel && !q;
    const locs = [...new Set(remaining.map((m) => m.details?.location ?? ''))];
    const byLoc = locs.length > 1
      ? locs.map((loc) => ({ loc, models: remaining.filter((m) => (m.details?.location ?? '') === loc) }))
      : [{ loc: '', models: remaining }];
    return {
      count: remaining.length + (missingDefault ? 1 : 0),
      node: <>
        {missingDefault && <button type="button" role="option" disabled aria-disabled="true" className="quiet-row text-xs text-ink-faint">{settings?.defaultModelId} <span className="text-2xs">Default · {defaultStatus}</span></button>}
        {byLoc.map(({ loc, models: ms }) => (
          <React.Fragment key={loc || '_'}>
            {loc && <p className="truncate px-3 pb-1 pt-2 text-2xs text-ink-faint" title={loc}>{loc}</p>}
            {ms.map((m) => row(p, m, showAccount))}
          </React.Fragment>
        ))}
      </>,
    };
  };

  // Group headings: the family is what you scan for, in ink a size up from the rows.
  const heading = (label: string) => <span data-provider-heading>{label}</span>;

  const familyGroup = (f: AccountFamily, column: ProviderConfig[]) => {
    const members = f.providers.filter((p) => column.includes(p));
    if (!members.length) return null;
    const several = members.length > 1;
    const shown = several && !q ? (members.includes(shownAccount(f)) ? shownAccount(f) : members[0]) : null;
    // Searching spans every account of the family, each row naming its account.
    const listed = q || !several ? members : [shown!];
    const rows = listed.map((p) => ({ p, ...providerRows(p, several && q ? 'account' : false) }));
    const meterProvider = shown ?? (members.length === 1 ? members[0] : null);
    const hasMeter = !q && !!meterProvider && !!limitsKeyFor(meterProvider) && modelsOf(meterProvider.id).length > 0;
    // While searching, a family with no match drops out entirely.
    if (!rows.some((r) => r.count) && (q || (!hasMeter && !several))) return null;
    // With tabs, the account on show says its own email and which account it is
    // under them ("me@x · Organization · Team"); the heading stays the family.
    const email = several ? undefined : idOf(members[0]).email;
    // One account: its own name and plan ride in the heading's meta, since there are no tabs to say it.
    const single = !several ? identityLine(idOf(members[0])) : '';
    const metaText = [single !== f.name ? single : '', email].filter(Boolean).join(' · ');
    const shownId = shown ? idOf(shown) : undefined;
    // The tab already says the plan; this says whose login it is and which account on it.
    const whoLine = !shownId?.email ? '' : [shownId.email, shownId.organization ? 'Organization' : shownId.plan ? 'Personal plan' : ''].filter(Boolean).join(' · ');
    const claudeSwitch = !!shown && shown.kind === 'claude-code' && currentProvider?.kind === 'claude-code' && members.filter((p) => p.kind === 'claude-code').length > 1;
    return (
      <Group key={f.id} as="div" dense role="group" label={f.name} title={heading(f.name)} meta={metaText && <span data-account-email title={metaText}>{metaText}</span>} data-provider-group={f.id}>
        {several && !q && (
          <div className="px-1 pb-1" data-account-switcher>
            <QuietTabs
              label={`${f.name} account`}
              role="radiogroup"
              value={shown!.id}
              onChange={(id) => { const p = members.find((x) => x.id === id); if (p) chooseAccount(f, p); }}
              items={members.map((p) => ({
                value: p.id,
                label: idOf(p).name,
                hint: idOf(p).hint,
                title: accountTabTitle(f, p),
                icon: p.id === providerId ? <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-accent" aria-label="This chat" /> : undefined,
              }))}
            />
            {whoLine && <p className="truncate px-2 pt-1 text-2xs text-ink-soft" data-account-who title={whoLine}>{whoLine}</p>}
            {claudeSwitch && <p className="px-2 pt-1 text-2xs text-ink-faint">Switching starts a new Claude Code conversation; history stays here.</p>}
          </div>
        )}
        {hasMeter && <ProviderUsageMeters compact limits={limitsOf(meterProvider!)} answered={answered.has(limitsKeyFor(meterProvider!)!)} />}
        {rows.map((r) => <React.Fragment key={r.p.id}>{r.node}</React.Fragment>)}
        {several && !q && shown && rows[0]?.count === 0 && (
          <p className="px-3 py-1 text-2xs text-ink-faint">{byProvider[shown.id] === undefined ? 'Loading models…' : byProvider[shown.id] === null ? 'Could not load this account\'s models.' : 'No models on this account.'}</p>
        )}
      </Group>
    );
  };

  const pinnedGroup = (label: string, entries: { provider: ProviderConfig; model: ModelInfo }[], column: ProviderConfig[]) => {
    const list = entries.filter((s) => column.includes(s.provider) && `${s.provider.id}::${s.model.id}` !== defaultKey);
    if (!list.length || q) return null;
    return <Group as="div" dense title={<span className="text-xs font-medium text-ink-soft">{label}</span>}>{list.map((s) => row(s.provider, s.model, 'family'))}</Group>;
  };

  const columns = [
    { id: 'cloud', label: 'Cloud', providers: visibleProviders.filter((p) => !isLocalProvider(p.kind)) },
    { id: 'local', label: 'Local', providers: visibleProviders.filter((p) => isLocalProvider(p.kind)) },
  ].filter((column) => column.providers.length > 0);

  const stacked = columns.length === 2 && narrow;

  const popup = (
        <div ref={popupRef} style={expanded ? undefined : placement} className={expanded ? 'flex h-full min-h-0 w-full flex-col text-left' : 'quiet-popover fixed z-50 flex flex-col p-2'} data-model-picker>
          <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 px-1">
            {(expanded || total > 8) && (
              <input
                className="quiet-field min-w-40 flex-1 text-xs"
                placeholder="Search models"
                value={query}
                autoFocus={!expanded}
                aria-label="Filter models"
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <div role="group" aria-label="Model source" className="flex shrink-0 items-center gap-1">
              {([
                ['all', 'All', GridIcon], ['fusion', 'Fusion', RouteIcon],
                ['cloud', 'Cloud', CloudIcon], ['local', 'Local', LaptopIcon],
              ] as const).map(([value, label, Icon]) => (
                <button key={value} type="button" aria-pressed={scope === value}
                  disabled={value === 'fusion' && !allowAuto}
                  title={value === 'fusion' ? (allowAuto ? 'Auto routing between models' : 'Auto routing is not available here') : `${label} models`}
                  onClick={() => setScope(value)}
                  className="quiet-tab items-center">
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col" role="listbox" aria-label="Model">
            {providers.length === 0 && <p className="px-3 py-1 text-2xs text-ink-faint">No provider configured.</p>}
            {providers.length > 0 && groups.length === 0 && scope !== 'fusion' && (
              <p className="px-3 py-1 text-2xs text-ink-faint">{q ? 'No models match.' : pending ? 'Loading models…' : 'No models available.'}</p>
            )}
            {allowAuto && total > 1 && !q && (scope === 'all' || scope === 'fusion') && (
              <button
                type="button"
                role="option"
                aria-selected={modelId === AUTO_MODEL_ID}
                className="quiet-row mb-2 text-xs"
                onClick={() => { onModel(providerId ?? '', AUTO_MODEL_ID); setOpen(false); }}
                title="Nekko Agent picks the best model for each message"
              >
                <span className={`font-medium ${modelId === AUTO_MODEL_ID ? 'text-accent' : 'text-ink'}`}>✨ Auto</span>
                <span className="text-2xs text-ink-faint">Picks the best model for each message</span>
                {modelId === AUTO_MODEL_ID && <CheckIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />}
              </button>
            )}
            <div className={stacked ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain' : `grid min-h-0 flex-1 ${columns.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`} data-model-columns={columns.length}>
              {columns.map((column, index) => (
                <section key={column.id} aria-label={`${column.label} models`} className={stacked ? 'min-w-0' : 'flex min-h-0 min-w-0 flex-col'} style={index > 0 ? (stacked ? { boxShadow: 'inset 0 1px 0 var(--line)', marginTop: 'var(--q-group)', paddingTop: 16 } : { boxShadow: 'inset 1px 0 0 var(--line)' }) : undefined} data-model-column={column.id}>
                  {columns.length === 2 && <h3 className="quiet-group-label shrink-0 px-4 pb-2">{column.label}</h3>}
                  <div className={stacked ? 'px-1' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-1'} data-model-scroll={column.id}>
                    {pinnedGroup('Recent', recentModels, column.providers)}
                    {pinnedGroup('★ Starred', starred, column.providers)}
                    {families.map((f) => familyGroup(f, column.providers))}
                    {q && !groups.some((g) => column.providers.includes(g.provider)) && <p className="px-3 py-1 text-2xs text-ink-faint">No matches.</p>}
                  </div>
                </section>
              ))}
            </div>
          </div>
          {footer}
        </div>
  );

  return (
    // min-w-20: squeezed by a phone-width strip, the chip used to wrap its name one letter per line.
    <div ref={ref} className={expanded ? 'h-full min-h-0 w-full min-w-0' : 'relative min-w-20 max-w-[260px]'}>
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
        <span className={`min-w-0 ${placeholder && !modelId ? 'whitespace-nowrap' : 'whitespace-normal'} break-words text-left`} data-model-chip-name>{unavailableModel ? <><s className="opacity-80">{unavailableModel}</s> · unavailable</> : needsChoice ? 'Choose a model' : placeholder && !modelId ? placeholder : currentName}</span>
        {chipAccount && !unavailableModel && !needsChoice && <span className="min-w-0 max-w-[96px] shrink truncate text-ink-faint" data-model-chip-account>{chipAccount}</span>}
        <span className="ctl-caret shrink-0">▾</span>
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
        <div className="quiet-popover absolute bottom-8 left-0 z-40 w-60 p-2" role="menu">
          {AUTO_QUALITIES.map((q) => (
            <button
              key={q}
              role="menuitemradio"
              aria-checked={quality === q}
              className={`quiet-row flex-col items-start gap-0 ${quality === q ? 'text-accent' : ''}`}
              onClick={() => { onPick(q); setOpen(false); }}
            >
              <span className="text-sm font-medium">{AUTO_QUALITY_META[q].label}</span>
              <span className="text-2xs text-ink-faint">{AUTO_QUALITY_META[q].description}</span>
            </button>
          ))}
          {onFollowCapacity && (
            <button
              role="menuitemcheckbox"
              aria-checked={!!followCapacity}
              className="quiet-row items-start"
              onClick={() => onFollowCapacity(!followCapacity)}
            >
              <span
                className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-2xs ${followCapacity ? 'border-accent bg-accent text-on-accent' : 'border-line'}`}
                aria-hidden
              >
                {followCapacity ? '✓' : ''}
              </span>
              <span>
                <span className="block text-sm font-medium">Follow capacity &amp; cost</span>
                <span className="block text-2xs leading-snug text-ink-faint">
                  When this provider is spent or an equivalent model elsewhere is much cheaper, run the turn there and say why. Never a downgrade.
                </span>
              </span>
            </button>
          )}
          <p className="px-3 pb-1 pt-2 text-2xs text-ink-faint">Applies to this chat only.</p>
        </div>
      )}
    </div>
  );
}

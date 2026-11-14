import { FirstProviderSetup } from '../components/providers/FirstProviderSetup.js';
import { needsProviderSetup } from '../components/providers/providerSetup.js';
import { useEffect, useRef, useState } from 'react';
import type { ClaudeCodeStatus, LimitWindow, ModelInfo, OAuthProvider, OAuthStatus, ProviderConfig, ProviderKind, SubscriptionLimits } from '@nekko-agent/shared';
import { formatUSD, isLocalProvider, limitsKeyFor, isRuntimeKind, formatModelPriceLabel, modelPricing, oauthProviderOffered } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { Badge, Toggle } from '../components/primitives/index.js';
import { SubscriptionSignIn } from '../components/SubscriptionSignIn.js';
import { type ProviderSetupKind } from '../components/providers/providerPresets.js';
import { AddProvider, SUBSCRIPTION_KINDS, reconnectProviderConfig } from '../components/providers/AddProvider.js';
import { ClaudeWhyLink, useClaudeCodeStatus } from '../components/claude/ClaudeAgent.js';
import { claudeSourceLine, claudeIdentityLine, isClaudeKind } from '../components/claude/ClaudeSetup.js';
import { TrashIcon, CheckIcon, StarIcon, CloseIcon } from '../icons.js';
import { ContextMenu, ContextAction } from '../components/ContextMenu.js';
import { RuntimeCard } from '../components/runtimes/RuntimeCard.js';
import { matchesModelQuery } from '../components/agent-console/modelPickerInteractions.js';
import { MODEL_FILTER_THRESHOLD, modelListProblem } from './modelListProblem.js';
import { MiddleTruncate } from '../components/primitives/MiddleTruncate.js';
import { ModelRowName } from './ModelRowName.js';
import { ProviderMark, providerMarkKind } from '../components/providers/ProviderMark.js';
import { ProviderBillingBadge } from '../components/providers/ProviderBillingBadge.js';
import { ProviderFamilies } from './ProviderFamilies.js';

const isLocal = (k: ProviderKind) => isLocalProvider(k);

/** Compact "in 12m" / "in 2h" countdown for a future timestamp. */
function timeUntil(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'soon';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60 ? `${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

/** Format a subscription session expiry as a short, human-readable note. */
function formatExpiry(expiresAt?: number): string | null {
  if (!expiresAt) return null;
  const now = Date.now();
  const delta = expiresAt - now;
  if (delta <= 0) return 'Session expired';
  const mins = Math.ceil(delta / 60_000);
  if (mins < 60) return `Session expires in ${mins}m`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 24) {
    const rem = Math.floor((delta % 3_600_000) / 60_000);
    return `Session expires in ${hours}h ${rem}m`;
  }
  const days = Math.floor(delta / 86_400_000);
  return `Session expires in ${days} day${days === 1 ? '' : 's'}`;
}

export function ModelsView({ localOnly = false }: { localOnly?: boolean }) {
  const { providers, refreshProviders, pushToast } = useStore(
    useShallow((s) => ({
      providers: s.providers,
      refreshProviders: s.refreshProviders,
      pushToast: s.pushToast,
    })),
  );
  // Keep this flow mounted through saving so its completion step does not disappear.
  const [firstSetup] = useState(() => needsProviderSetup(providers, useStore.getState().activeModelId ?? useStore.getState().models[0]?.id));
  const [adding, setAdding] = useState(false);
  const setupRef = useRef<HTMLDivElement>(null);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!adding) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !setupRef.current?.contains(event.target) && !shortcutsRef.current?.contains(event.target)) setAdding(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setAdding(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [adding]);
  // A notice action ("Use my subscription", "Add API key") opens the form on a kind.
  const [addKind, setAddKind] = useState<ProviderSetupKind | undefined>();
  const requestedKind = useStore((s) => s.addProviderKind);
  // The local and cloud sections share one page, so the form may open below the fold.
  const reveal = useRef(false);
  useEffect(() => {
    if (!requestedKind || isLocal(requestedKind) !== localOnly) return;
    setAddKind(requestedKind);
    setAdding(true);
    reveal.current = true;
    useStore.setState({ addProviderKind: null });
  }, [requestedKind, localOnly]);
  useEffect(() => {
    if (!adding || !reveal.current) return;
    reveal.current = false;
    setupRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [adding]);
  const [discovering, setDiscovering] = useState(false);

  useEffect(() => {
    refreshProviders();
  }, [refreshProviders]);

  const discover = async () => {
    setDiscovering(true);
    const before = providers.length;
    const after = await window.nekko.discoverProviders();
    await refreshProviders();
    setDiscovering(false);
    const added = after.length - before;
    pushToast(added > 0 ? 'success' : 'info', added > 0
      ? `Found ${added} local server${added === 1 ? '' : 's'}.`
      : 'No new local servers found on localhost. Running on another host/port? Add it manually.');
  };

  const visible = providers.filter((p) => p.kind !== 'llamacpp' && isLocal(p.kind) === localOnly);
  const openAdd = (kind?: ProviderSetupKind) => { setAddKind(kind); setAdding((open) => !(open && kind === addKind)); };

  if (firstSetup && !localOnly) return <div className="h-full overflow-y-auto"><FirstProviderSetup /></div>;

  return (
    <section className="models-providers" aria-label={localOnly ? 'Connected local servers' : 'Cloud providers'}>
      <div className="models-provider-bar">
        <div ref={shortcutsRef}><ProviderShortcuts localOnly={localOnly} onAdd={openAdd} open={adding ? addKind : undefined} /></div>
      </div>
      {localOnly && <button className="btn mb-4" onClick={discover} disabled={discovering}>
        {discovering ? 'Scanning…' : 'Discover local servers'}
      </button>}
      {adding && <div ref={setupRef} className="provider-setup" data-provider-setup={addKind ?? 'any'}>
        <button type="button" className="provider-setup-close" aria-label="Close provider setup" title="Close" onClick={() => setAdding(false)}><CloseIcon className="h-4 w-4" /></button>
        <AddProvider scope={localOnly ? 'local' : 'cloud'} key={addKind ?? 'any'} fixedKind={addKind} onDone={() => { setAdding(false); setAddKind(undefined); refreshProviders(); }} />
      </div>}
      {localOnly
        ? <div className="models-provider-grid">
          {visible.map((p) => <div key={p.id} id={`provider-${p.id}`}><ProviderCard provider={p} onChanged={refreshProviders} /></div>)}
        </div>
        // Cloud providers read as families with their accounts and models (quiet surfaces).
        : <ProviderFamilies
          providers={visible}
          onAdd={(kind) => { reveal.current = true; setAddKind(kind); setAdding(true); }}
          renderDetails={(p) => <ProviderCard provider={p} onChanged={refreshProviders} embedded />}
        />}
    </section>
  );
}

const CLOUD_SHORTCUTS: { kind: ProviderSetupKind; label: string }[] = [
  { kind: 'chatgpt', label: 'ChatGPT' },
  { kind: 'anthropic', label: 'Claude' },
  { kind: 'openai', label: 'OpenAI API' },
  { kind: 'openrouter', label: 'OpenRouter' },
  { kind: 'gemini', label: 'Google Gemini' },
];
const MORE_SHORTCUTS: { kind: ProviderSetupKind; label: string }[] = [
  { kind: 'vertex', label: 'Claude on Vertex AI' },
  { kind: 'ollama-cloud', label: 'Ollama Cloud' },
  { kind: 'openai-compat', label: 'OpenAI-compatible' },
];
const LOCAL_SHORTCUTS: { kind: ProviderSetupKind; label: string }[] = [
  { kind: 'ollama', label: 'Ollama' },
  { kind: 'lmstudio', label: 'LM Studio' },
  { kind: 'vllm', label: 'vLLM' },
];

/**
 * The add-a-provider strip: each provider as its mark and name, quiet until
 * hovered. The one whose setup is open reads as selected.
 */
export function ProviderShortcuts({ localOnly = false, onAdd, open }: { localOnly?: boolean; onAdd: (kind: ProviderSetupKind) => void; open?: ProviderSetupKind }) {
  const [expanded, setExpanded] = useState(false);
  const firstRevealed = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (expanded) firstRevealed.current?.focus({ preventScroll: true }); }, [expanded]);
  // A setup opened on a kind behind More (a notice's action) shows it in the strip.
  const showMore = expanded || MORE_SHORTCUTS.some((s) => s.kind === open);
  const choices = localOnly ? LOCAL_SHORTCUTS : [...CLOUD_SHORTCUTS, ...(showMore ? MORE_SHORTCUTS : [])];
  return <div className="models-add-strip" role="group" aria-label="Add provider">
    {choices.map(({ kind, label }, index) => {
      const revealed = !localOnly && index >= CLOUD_SHORTCUTS.length;
      return <button key={kind} ref={!localOnly && index === CLOUD_SHORTCUTS.length ? firstRevealed : undefined} type="button" className={`models-add-provider${revealed ? ' models-add-revealed' : ''}`} style={revealed ? { animationDelay: `${(index - CLOUD_SHORTCUTS.length) * 35}ms` } : undefined} title={`Add ${label}`} aria-label={`Add ${label}`} aria-pressed={open === kind} onClick={() => onAdd(kind)}>
        <ProviderMark kind={kind} tile />
        <span>{label}</span>
      </button>;
    })}
    {!localOnly && !showMore && <button type="button" className="models-add-provider models-add-more" title="More providers" aria-label="More providers" aria-expanded={false} onClick={() => setExpanded(true)}>More</button>}
  </div>;
}

/** Where a Claude card's models come from (subscription or API, and which account). */
function ClaudeSource({ provider, status }: { provider: ProviderConfig; status?: ClaudeCodeStatus | null }) {
  return provider.kind === 'claude-code'
    ? <p className="claude-source" title={claudeSourceLine(provider, status)}>{[claudeIdentityLine(status) || 'Through Claude Code', provider.claudeCode?.account].filter(Boolean).join(' · ')}</p>
    : <p className="claude-source">{claudeSourceLine(provider)}</p>;
}

const LIMIT_STATUS_COLOR: Record<LimitWindow['status'], string> = {
  allowed: 'var(--success)',
  warning: 'var(--warning)',
  rate_limited: 'var(--danger)',
};

export function LimitsPanel({ limits, now, subName }: { limits: SubscriptionLimits | null; now: number; subName: string }) {
  if (!limits) return null;
  const windowOrder: LimitWindow['scope'][] = ['session', 'weekly', 'model'];
  const sorted = [...limits.windows].sort(
    (a, b) => windowOrder.indexOf(a.scope) - windowOrder.indexOf(b.scope) || b.usedPercent - a.usedPercent,
  );
  return (
    <div className="mt-3 space-y-1 border-t border-line pt-3">
      <div className="flex items-center justify-between text-2xs text-ink-faint">
        <span title={`Live read from ${subName}`}>Plan: {limits.planType ?? '—'}</span>
        {limits.creditsBalance !== undefined && <span>Credits: {formatUSD(limits.creditsBalance)}</span>}
      </div>
      {now - limits.updatedAt > limits.staleAfterMs && <p className="text-2xs text-ink-faint">Last reported usage · may be out of date</p>}
      {sorted.length === 0 ? (
        <p className="text-2xs text-ink-faint">No usage windows reported yet.</p>
      ) : (
        <div className="space-y-1">
          {sorted.map((w) => (
            <div key={w.id} className="flex items-center gap-2 text-2xs">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: LIMIT_STATUS_COLOR[w.status] }}
                title={w.status === 'rate_limited' ? 'Rate limited' : w.status === 'warning' ? 'Warning' : 'OK'}
              />
              <span className="min-w-0 flex-1 truncate text-ink-soft">{w.label}</span>
              <span className="shrink-0 tabular-nums font-medium">{Math.round(w.usedPercent)}%</span>
              <span className="shrink-0 text-right tabular-nums text-ink-faint" title={Number.isFinite(w.resetAt) && w.resetAt > 0 ? `Resets ${new Date(w.resetAt).toLocaleString()}` : undefined}>
                {Number.isFinite(w.resetAt) && w.resetAt > 0 ? `Resets ${timeUntil(w.resetAt - now)}` : 'Reset unavailable'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * A Claude plan card from an older build. Nekko Agent no longer signs in to
 * Claude plans, so the card explains that and turns into an API-key card when
 * the user adds a key. Nothing here touches Claude credentials.
 */
function RetiredClaudePlan({ provider, onChanged }: { provider: ProviderConfig; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const useKey = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const next: ProviderConfig = {
        ...provider,
        label: provider.label.replace(/\s*\(subscription\)\s*$/i, '') || 'Claude',
        auth: 'apikey',
        apiKey: apiKey.trim(),
        tokenKey: undefined,
        accountId: undefined,
        enabled: true,
      };
      const check = await window.nekko.testProviderConfig(next);
      if (!check.ok) {
        setError(check.message);
        return;
      }
      await window.nekko.saveProvider(next);
      onChanged();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 rounded-xl border p-3 text-xs" style={{ borderColor: 'var(--line)' }}>
      <p className="text-ink-soft">
        Nekko Agent no longer signs in to Claude plans, so this card is turned off and its saved Claude sign-in was deleted.
        Add an Anthropic API key to keep using it, billed per token to your Anthropic account, or keep using your plan through the Subscription option, which runs your installed Claude Code.
      </p>
      <div className="flex gap-2">
        <input
          className="input py-1 text-xs"
          type="password"
          aria-label="Anthropic API key"
          placeholder="sk-ant-…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button className="btn btn-primary py-1 text-xs" disabled={saving || !apiKey.trim()} onClick={() => void useKey()}>
          {saving ? 'Checking…' : 'Use this key'}
        </button>
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-outline py-1 text-xs" onClick={() => useStore.getState().openAddProvider('claude-code')}>Use my subscription instead</button>
        <ClaudeWhyLink label="What works with a Claude plan?" />
      </div>
    </div>
  );
}

type ProviderCardProps = {
  provider: ProviderConfig;
  onChanged: () => void;
  /** Under an account row on the Models page: no card, no header (the row is the header), no model list (the family lists them). */
  embedded?: boolean;
};

function ProviderCard(props: ProviderCardProps) {
  // Only enabled Claude Code cards probe the CLI. Source and chip share one read.
  return props.provider.kind === 'claude-code' && props.provider.enabled !== false
    ? <ClaudeCodeProviderCard key={props.provider.id} {...props} />
    : <ProviderCardContent {...props} />;
}

function ClaudeCodeProviderCard(props: ProviderCardProps) {
  const { status } = useClaudeCodeStatus(props.provider.id);
  return <ProviderCardContent {...props} claudeStatus={status} />;
}

function ProviderCardContent({ provider, onChanged, embedded = false, claudeStatus }: ProviderCardProps & { claudeStatus?: ClaudeCodeStatus | null }) {
  const settings = useStore((s) => s.settings);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const pushToast = useStore((s) => s.pushToast);
  // Only an explicit off switch disables; older entries without the field stay on.
  const enabled = provider.enabled !== false;
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [listError, setListError] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [conn, setConn] = useState<{ state: 'unknown' | 'testing' | 'ok' | 'fail'; message?: string }>({ state: 'unknown' });
  const defaultSettings = useStore(s => s.settings);
  const [defaultMenu, setDefaultMenu] = useState<{x:number; y:number; id:string} | null>(null);
  const defaultId = defaultSettings?.defaultProviderId === provider.id ? defaultSettings.defaultModelId : undefined;
  // The query only applies while its box is shown, so a list that shrinks cannot hide every model.
  const filtering = models.length > MODEL_FILTER_THRESHOLD;
  const listedModels = models.filter((m) => !filtering || matchesModelQuery(m, query)).sort((a,b) => Number(b.id === defaultId) - Number(a.id === defaultId));
  const [pullName, setPullName] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // model id being (un)loaded
  const [stopping, setStopping] = useState(false);
  // Per-model load/unload for LM Studio rides its `lms` CLI, so it's only
  // available for a local instance with the CLI installed. `null` = not yet
  // probed; the reason feeds the fallback badge's tooltip.
  const [lms, setLms] = useState<{ available: boolean; reason?: string } | null>(null);
  // Sign-in providers keep their credential host-side in the token store; the
  // renderer only ever sees this sanitized status (connected/account/expiry,
  // never a token). OpenRouter joins them with auth 'apikey' + a tokenKey: the
  // key its sign-in minted is metered, not a plan.
  //
  // A Claude plan card saved by an older build is neither: Claude sign-in is
  // not offered (its approved-client slot is empty), the startup migration
  // disabled the card and deleted its token, and the card offers an API key
  // instead (RetiredClaudePlan).
  const retiredClaudePlan = provider.kind === 'anthropic' && provider.auth === 'subscription' && !oauthProviderOffered('claude');
  const subscription =
    (provider.auth === 'subscription' && !retiredClaudePlan) || (provider.kind === 'openrouter' && !!provider.tokenKey);
  const [sub, setSub] = useState<OAuthStatus | null>(null);
  const [limits, setLimits] = useState<SubscriptionLimits | null>(null);
  const [relinking, setRelinking] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const subName = provider.kind === 'chatgpt' ? 'ChatGPT' : provider.kind === 'openrouter' ? 'OpenRouter' : 'Claude';
  const subOAuthProvider: OAuthProvider =
    provider.kind === 'chatgpt' ? 'chatgpt' : provider.kind === 'openrouter' ? 'openrouter' : 'claude';
  // A cloud card holding a dead credential (missing/revoked key) can reset
  // itself in place through the kind's sign-in; kinds with no sign-in flow
  // (OpenAI, openai-compat) keep the remove-and-re-add path.
  const reconnectOAuth = SUBSCRIPTION_KINDS[provider.kind];
  const [reconnecting, setReconnecting] = useState(false);

  const isFavorite = (key: string) => (settings?.favoriteModels ?? []).includes(key);
  const toggleFavorite = async (key: string) => {
    const set = new Set(settings?.favoriteModels ?? []);
    set.has(key) ? set.delete(key) : set.add(key);
    await window.nekko.updateSettings({ favoriteModels: [...set] });
    refreshSettings();
  };

  const setDefaultModel = (id: string) => {
    void window.nekko.updateSettings({ defaultProviderId: provider.id, defaultModelId: id }).then(() => refreshSettings()).catch((e) => pushToast('error', String(e)));
  };

  const load = async () => {
    const r = await window.nekko.listModelsStatus(provider.id).catch((e) => ({ models: [], error: String((e as Error)?.message ?? e) }));
    setModels(r.models);
    setListError(r.error);
  };

  const retry = () => {
    void load();
    void test();
  };

  const test = async () => {
    setConn({ state: 'testing' });
    const r = await window.nekko.testProvider(provider.id);
    setConn({ state: r.ok ? 'ok' : 'fail', message: r.message });
  };

  // Auto-check connectivity (and load models) when the card mounts, but only
  // for an enabled provider: a disabled one is never contacted.
  useEffect(() => {
    if (!enabled) { setModels([]); setListError(undefined); setConn({ state: 'unknown' }); return; }
    load();
    test();
    if (provider.kind === 'lmstudio') {
      window.nekko.lmsAvailable(provider.id).then(setLms).catch(() => setLms({ available: false }));
    }
    if (subscription) {
      window.nekko.oauthStatus(provider.id).then(setSub).catch(() => setSub(null));
    }
    /* eslint-disable-next-line */
  }, [provider.id, provider.tokenKey, enabled]);

  // A background catalog refresh (Settings → Updates) can land new models on
  // this card while the page is open.
  useEffect(() => window.nekko.onModelsUpdated((e) => {
    if (e.providerId === provider.id) void load();
    /* eslint-disable-next-line */
  }), [provider.id]);

  // Keep the badge honest when the host refreshes or signs out the token this
  // card points at (e.g. a mid-chat renewal lands while the page is open).
  useEffect(() => {
    if (!subscription) return;
    return window.nekko.onOAuthStatus((s) => {
      if (s.tokenKey && s.tokenKey === provider.tokenKey) setSub(s);
    });
  }, [subscription, provider.tokenKey]);

  // Canonical limits key: Claude Code reports its own usage; no credential reads.
  useEffect(() => {
    const tokenKey = enabled ? limitsKeyFor(provider) : null;
    setLimits(null);
    if (!tokenKey) return;
    let live = true;
    window.nekko.getLimits(tokenKey).then((l) => { if (live) setLimits(l ?? null); }).catch(() => {});
    const off = window.nekko.onLimitsUpdated((e) => {
      if (e.tokenKey === tokenKey) setLimits(e.limits);
    });
    return () => { live = false; off(); };
  }, [provider.id, provider.kind, provider.tokenKey, provider.auth, enabled]);

  const signOutSubscription = async () => {
    setRelinking(false);
    await window.nekko.oauthSignOut(provider.id);
    setSub(await window.nekko.oauthStatus(provider.id).catch(() => null));
    pushToast('info', provider.kind === 'openrouter' ? 'OpenRouter key removed.' : `Signed out of the ${subName} subscription.`);
  };

  // A re-auth (or a first connect on an existing card) returns a new tokenKey;
  // fold it onto the provider and re-check status against the saved config.
  const relinkSubscription = async (status: OAuthStatus) => {
    setRelinking(false);
    // A re-auth can land under a different tokenKey; sign the old one out
    // before repointing the provider so it doesn't linger in the host store.
    if (provider.tokenKey && provider.tokenKey !== status.tokenKey) {
      await window.nekko.oauthSignOut(provider.id).catch(() => {});
    }
    await window.nekko.saveProvider({
      ...provider,
      // OpenRouter keeps auth 'apikey': the key its sign-in minted is metered.
      auth: provider.auth,
      tokenKey: status.tokenKey || provider.tokenKey,
      accountId: status.accountId ?? provider.accountId,
    });
    setSub(await window.nekko.oauthStatus(provider.id).catch(() => null));
    pushToast(
      'success',
      provider.kind === 'openrouter' ? 'OpenRouter key connected.' : `Signed in with your ${subName} subscription.`,
    );
    onChanged();
    // Re-probe right away: the card keeps its old conn state across the prop
    // refresh, so without this an "Offline" badge would linger over a
    // connection that works again.
    load();
    void test();
  };

  // "Reconnect" on a failing api-key card: the same sign-in, but the result
  // also resets the stored credential and flips the card to subscription auth.
  const reconnectSubscription = async (status: OAuthStatus) => {
    setReconnecting(false);
    if (provider.tokenKey && provider.tokenKey !== status.tokenKey) {
      await window.nekko.oauthSignOut(provider.id).catch(() => {});
    }
    await window.nekko.saveProvider(reconnectProviderConfig(provider, status));
    setSub(await window.nekko.oauthStatus(provider.id).catch(() => null));
    pushToast(
      'success',
      provider.kind === 'openrouter' ? 'OpenRouter key connected.' : `Signed in with your ${subName} subscription.`,
    );
    onChanged();
    load();
    void test();
  };

  // While connected, refresh the loaded state periodically — local servers
  // JIT-load/evict models as they're used, so this keeps the badges honest.
  useEffect(() => {
    if (conn.state !== 'ok') return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.state, provider.id]);

  const isOllama = provider.kind === 'ollama';
  const local = isLocal(provider.kind);
  const anyLoaded = models.some((m) => m.loaded);
  const problem = modelListProblem({ error: listError, connFailed: conn.state === 'fail', local, label: provider.label, baseUrl: provider.baseUrl });
  // Ollama always supports per-model load/unload; LM Studio does too once its
  // `lms` CLI is reachable. Others fall back to the static badge + Stop server.
  const canManage = isOllama || (provider.kind === 'lmstudio' && lms?.available === true);

  const setLoaded = async (m: ModelInfo, loaded: boolean) => {
    setBusy(m.id);
    try {
      const r = loaded
        ? await window.nekko.loadModel(provider.id, m.id)
        : await window.nekko.unloadModel(provider.id, m.id);
      if (r && !r.ok) pushToast('error', r.message ?? `Couldn't ${loaded ? 'load' : 'unload'} ${m.id}.`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const stopServer = async () => {
    if (!window.confirm(`Stop the ${provider.label} server? This unloads its models and ends the process.`)) return;
    setStopping(true);
    const r = await window.nekko.stopServer(provider.id);
    pushToast(r.ok ? 'success' : 'error', r.message);
    setStopping(false);
    setTimeout(test, 600); // reflect the now-offline state
    load();
  };

  const setEnabled = async (next: boolean) => {
    await window.nekko.saveProvider({ ...provider, enabled: next });
    onChanged();
  };

  const header = (
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderMark kind={providerMarkKind(provider)} tile />
            <h3 className={`text-sm font-semibold ${enabled ? '' : 'text-ink-faint'}`}>{provider.label}</h3>
            {!enabled && <span className="chip">disabled</span>}
            {enabled && conn.state === 'ok' && (
              <Badge tone="success" variant="solid" className="px-2 py-0.5">
                <CheckIcon className="h-3 w-3" /> Connected
              </Badge>
            )}
            {enabled && conn.state === 'fail' && (
              <Badge tone="danger" variant="solid" title={conn.message}>Offline</Badge>
            )}
            {enabled && conn.state === 'testing' && <span className="chip">checking…</span>}
            <ProviderBillingBadge provider={provider} claudeStatus={claudeStatus} />
            {provider.discovered && <span className="chip">discovered</span>}
          </div>
          {isClaudeKind(provider.kind) && <ClaudeSource provider={provider} status={claudeStatus} />}
          {(!local || !enabled) && !subscription && provider.baseUrl && <p className="mt-0.5 font-mono text-2xs text-ink-faint">{provider.baseUrl}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
        <Toggle
          value={enabled}
          onChange={(v) => void setEnabled(v)}
          label={`${enabled ? 'Disable' : 'Enable'} ${provider.label}`}
          title={enabled ? 'Enabled: checked, listed in model pickers, and usable in chats. Click to disable.' : 'Disabled: never contacted or launched. Click to enable.'}
        />
        <button
          className="btn btn-ghost px-2"
          onClick={async () => {
            // Removing a subscription provider also drops its stored token so a
            // deleted card can't leave a live session behind.
            if (provider.tokenKey) await window.nekko.oauthSignOut(provider.id).catch(() => {});
            await window.nekko.removeProvider(provider.id);
            onChanged();
          }}
          title="Remove"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
        </div>
      </div>
  );

  if (retiredClaudePlan) {
    return (
      <div className={embedded ? 'min-w-0' : 'card p-5'}>
        {!embedded && header}
        <RetiredClaudePlan provider={provider} onChanged={onChanged} />
      </div>
    );
  }

  // A disabled provider is never contacted: no connection test, no model
  // list, no `lms` probe and no runtime polling, so a stopped LM Studio is
  // not woken just because this page opened.
  if (!enabled) {
    return (
      <div className={embedded ? 'min-w-0' : 'card p-5'}>
        {!embedded && header}
        <p className="mt-3 text-xs text-ink-faint">
          Disabled. Nekko Agent won't check, list, or start this provider, and it is hidden from model pickers. Turn it on to use it again.
        </p>
      </div>
    );
  }

  return (
    <div className={embedded ? 'min-w-0' : 'card p-5'}>
      {!embedded && header}
      {embedded && isClaudeKind(provider.kind) && <ClaudeSource provider={provider} status={claudeStatus} />}

      {/* A local server gets the full control surface: power, address, residency,
          and the fit planner. Start/stop, the address, and the model list all live
          in the card, so the old standalone "Stop server" button is gone. */}
      {local && isRuntimeKind(provider.kind) && (
        <div className="mt-3">
          <RuntimeCard
            provider={provider}
            kind={provider.kind}
            onChanged={() => {
              onChanged();
              load();
              test();
            }}
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-outline py-1 text-xs" onClick={test}>Test connection</button>
        {embedded && <button
          className="btn btn-ghost py-1 text-xs"
          onClick={async () => {
            if (provider.tokenKey) await window.nekko.oauthSignOut(provider.id).catch(() => {});
            await window.nekko.removeProvider(provider.id);
            onChanged();
          }}
        >
          Remove account
        </button>}
        {conn.state === 'fail' && <span className="text-xs" style={{ color: 'var(--danger)' }}>{conn.message}</span>}
        {conn.state === 'fail' && !subscription && reconnectOAuth && (
          <button className="btn btn-outline py-1 text-xs" onClick={() => setReconnecting((v) => !v)}>
            Reconnect
          </button>
        )}
      </div>

      {/* The failing-card fix path: sign in with the subscription (or mint a
          new OpenRouter key) and the credential on this card resets in place. */}
      {reconnecting && !subscription && reconnectOAuth && (
        <div className="mt-3 text-xs">
          <div className="space-y-2">
            <p className="text-ink-faint">
              {provider.kind === 'openrouter'
                ? 'Sign in again to mint a fresh key; it replaces the missing or revoked one on this card.'
                : `Sign in with your ${subName} subscription to reset this connection. The sign-in replaces the missing or stale API key, and the card runs on your plan from then on.`}
            </p>
            <SubscriptionSignIn
              oauthProvider={reconnectOAuth}
              label={`Sign in with ${subName}`}
              onConnected={reconnectSubscription}
            />
          </div>
        </div>
      )}

      {provider.kind === 'claude-code' && limits && <LimitsPanel limits={limits} now={now} subName="Claude Code" />}
      {subscription && (
        <div className="mt-3 text-xs">
          {sub === null ? (
            <span className="text-ink-faint">Checking sign-in…</span>
          ) : sub.connected ? (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-2 text-ink-soft">
                  <CheckIcon className="h-3.5 w-3.5 shrink-0 text-success" />
                  <span className="truncate" title={provider.accountId}>
                    Signed in
                  </span>
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    className="text-ink-faint hover:text-ink"
                    onClick={() => setRelinking(true)}
                  >
                    {provider.kind === 'openrouter' ? 'New key' : 'Sign in again'}
                  </button>
                  <span className="text-ink-faint">·</span>
                  <button className="text-ink-faint hover:text-ink" onClick={() => void signOutSubscription()}>
                    {provider.kind === 'openrouter' ? 'Remove key' : 'Sign out'}
                  </button>
                </div>
              </div>
              {sub.expiresAt && (
                <p style={{ color: (sub.expiresAt - Date.now()) < 3_600_000 ? 'var(--warning)' : 'var(--ink-faint)' }}>
                  {formatExpiry(sub.expiresAt)}
                </p>
              )}
              {relinking && (
                <div className="space-y-2 pt-1">
                  <p className="text-ink-faint">Sign in again to refresh the session or switch accounts.</p>
                  <SubscriptionSignIn
                    oauthProvider={subOAuthProvider}
                    label={`Sign in with ${subName}`}
                    onConnected={relinkSubscription}
                  />
                </div>
              )}

              <LimitsPanel limits={limits} now={now} subName={subName} />
            </div>
          ) : (
            <div className="space-y-2">
              <p style={{ color: 'var(--warning)' }}>
                {sub.state === 'error' && sub.message
                  ? sub.message
                  : provider.kind === 'openrouter'
                    ? 'The saved key is missing or was revoked — sign in again to mint a new one.'
                    : 'Subscription session expired or signed out — sign in again.'}
              </p>
              <SubscriptionSignIn
                oauthProvider={subOAuthProvider}
                label={`Sign in with ${subName}`}
                onConnected={relinkSubscription}
              />
            </div>
          )}
        </div>
      )}

      {isOllama && (
        <div className="mt-3 flex gap-2">
          <input className="input py-1 text-xs" placeholder="pull a model, e.g. llama3.2" value={pullName} onChange={(e) => setPullName(e.target.value)} />
          <button
            className="btn btn-outline py-1 text-xs"
            onClick={async () => { setConn({ state: 'testing', message: 'pulling…' }); const r = await window.nekko.pullModel(provider.id, pullName); setConn({ state: r.ok ? 'ok' : 'fail', message: r.message }); load(); }}
          >
            Pull
          </button>
        </div>
      )}

      {local && (
        <div className="mt-3 flex items-center justify-between text-2xs text-ink-faint">
          <span>{models.length} model{models.length === 1 ? '' : 's'}{anyLoaded ? ` · ${models.filter((m) => m.loaded).length} loaded` : ''}</span>
          <button className="hover:text-ink" onClick={load} title="Refresh loaded state">↻ Refresh</button>
        </div>
      )}

      {!embedded && filtering && (
        <input
          className="input mt-2 rounded-lg px-3 py-1 text-xs"
          placeholder="Filter models…"
          aria-label="Filter models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {!embedded && <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
        {models.length === 0 && (problem ? (
          <div className="flex items-start justify-between gap-2 text-xs" role="alert">
            <p className="min-w-0 break-words" style={{ color: 'var(--danger)' }}>{problem}</p>
            <button className="btn btn-outline shrink-0 px-2 py-0.5 text-2xs" onClick={retry}>Retry</button>
          </div>
        ) : (
          <p className="text-xs text-ink-faint">No models found.</p>
        ))}
        {models.length > 0 && listedModels.length === 0 && <p className="text-xs text-ink-faint">No models match.</p>}
        {defaultMenu && <ContextMenu x={defaultMenu.x} y={defaultMenu.y} onClose={() => setDefaultMenu(null)}><ContextAction onClick={() => { setDefaultModel(defaultMenu.id); setDefaultMenu(null); }}>Set as default</ContextAction></ContextMenu>}
        {defaultId && !models.some(m => m.id === defaultId) && <div aria-disabled="true" className="flex min-w-0 items-baseline gap-1 rounded-lg px-2 py-1 text-xs text-ink-faint"><MiddleTruncate text={defaultId} tail={20} /> <span className="shrink-0 text-2xs">Default · unavailable</span></div>}
        {listedModels.map((m) => {
          const price = formatModelPriceLabel({ modelId: m.id, auth: provider.auth, isLocal: local, pricing: modelPricing(m) });
          return (
            <div key={m.id} onContextMenu={(e) => { e.preventDefault(); setDefaultMenu({x:e.clientX,y:e.clientY,id:m.id}); }} className="flex items-center justify-between rounded-lg px-2 py-1 text-xs" style={{ background: 'var(--surface-2)' }}>
              <div className="flex min-w-0 items-center gap-2">
                <button
                title={isFavorite(`${provider.id}::${m.id}`) ? 'Unfavorite' : 'Favorite (pin to top of the model picker)'}
                className={isFavorite(`${provider.id}::${m.id}`) ? 'text-accent' : 'text-ink-faint hover:text-ink'}
                onClick={() => toggleFavorite(`${provider.id}::${m.id}`)}
              >
                <StarIcon className="h-3.5 w-3.5" filled={isFavorite(`${provider.id}::${m.id}`)} />
              </button>
              <ModelRowName name={m.name} isDefault={m.id === defaultId} onSetDefault={() => setDefaultModel(m.id)} />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {price && (
                <span className="max-w-[160px] truncate text-2xs text-ink-faint" title="Estimated list price per 1M tokens">{price}</span>
              )}
              {m.vramBytes ? (
                <span className="text-2xs text-ink-faint" title="VRAM used while loaded">{(m.vramBytes / 1e9).toFixed(1)} GB VRAM</span>
              ) : m.sizeBytes ? (
                <span className="text-2xs text-ink-faint" title="Size on disk">{(m.sizeBytes / 1e9).toFixed(1)} GB</span>
              ) : null}
              {canManage ? (
                m.loaded ? (
                  <button
                    className="chip chip-loaded text-white!"
                    style={{ background: 'var(--success)' }}
                    disabled={busy === m.id}
                    onClick={() => setLoaded(m, false)}
                    title="Loaded in memory, click to unload"
                  >
                    <CheckIcon className="h-3 w-3" />
                    {busy === m.id ? (
                      'unloading…'
                    ) : (
                      <>
                        {/* Reads as state at rest, as an action under the cursor. */}
                        <span className="chip-loaded-rest">loaded</span>
                        <span className="chip-loaded-hover">unload</span>
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    className="chip chip-action"
                    disabled={busy === m.id}
                    onClick={() => setLoaded(m, true)}
                    title={`Load ${m.name} into memory`}
                  >
                    {busy === m.id ? 'loading…' : 'load'}
                  </button>
                )
              ) : local && m.loaded ? (
                <Badge tone="success" variant="solid" title={lms?.reason ?? 'Loaded in memory. Use “Stop server” to unload.'}>
                  <CheckIcon className="h-3 w-3" /> loaded
                </Badge>
              ) : null}
            </div>
          </div>
        );
        })}
      </div>}
    </div>
  );
}

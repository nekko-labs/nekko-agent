import React, { useEffect, useState } from 'react';
import type { ModelInfo, OAuthStatus, ProviderConfig, ProviderKind } from '@nekko-agent/shared';
import { PROVIDER_DEFAULTS, isLocalProvider, formatModelPriceLabel, modelPricing, oauthProviderOffered } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store.js';
import { Badge } from '../primitives/index.js';
import { SubscriptionSignIn } from '../SubscriptionSignIn.js';
import { AddProvider, matchingProviders, subscriptionProviderConfig } from '../providers/AddProvider.js';
import { CheckIcon, ServerIcon } from '../../icons.js';

type TestState = { state: 'testing' } | { state: 'done'; ok: boolean; message: string };

/**
 * The providers step: online options (ChatGPT first, Claude, OpenRouter, any
 * OpenAI-compatible endpoint) and one-click local servers
 * (Ollama / LM Studio / vLLM) discovered by probing localhost on mount. The
 * probe writes nothing - a server is only saved when the user clicks Add - so
 * skipping the step stays non-destructive. A kind that is already configured
 * shows as connected instead of offering a duplicate add.
 */
export function ProvidersStep({ onExit }: { onExit?: (after?: () => void) => void }) {
  const { providers, refreshProviders, pushToast, setView, setOnboardingOpen } = useStore(
    useShallow((s) => ({
      providers: s.providers,
      refreshProviders: s.refreshProviders,
      pushToast: s.pushToast,
      setView: s.setView,
      setOnboardingOpen: s.setOnboardingOpen,
    })),
  );
  const [scan, setScan] = useState<'scanning' | 'done' | 'failed'>('scanning');
  const [found, setFound] = useState<ProviderConfig[]>([]);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [chatgptModel, setChatgptModel] = useState('');

  // Refresh what's already configured, then probe localhost for running model
  // servers. `probeProviders` is read-only (unlike `discoverProviders`, which
  // merges hits into settings), so nothing is persisted until Add is clicked.
  useEffect(() => {
    void refreshProviders();
    let alive = true;
    window.nekko
      .probeProviders()
      .then((list) => {
        if (!alive) return;
        setFound(list);
        setScan('done');
      })
      .catch(() => {
        if (alive) setScan('failed');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async () => {
    await refreshProviders();
  };

  // A completed subscription sign-in only hands back a sanitized status; save
  // it as an auth:'subscription' provider (same path as the Models tab).
  const connectSubscription =
    (oauthProvider: 'claude' | 'chatgpt', customModelId?: string) => async (status: OAuthStatus) => {
      await window.nekko.saveProvider(subscriptionProviderConfig(status, { customModelId }));
      pushToast('success', `Signed in with your ${oauthProvider === 'claude' ? 'Claude' : 'ChatGPT'} subscription.`);
      await refresh();
    };

  // Dedup: a provider of a card's kind already configured means the card is
  // connected - we never re-add the same kind from the wizard.
  const claude = matchingProviders(providers, ['anthropic']);
  const claudeSignIn = oauthProviderOffered('claude');
  const chatgpt = matchingProviders(providers, ['chatgpt', 'openai']);
  const openrouter = matchingProviders(providers, ['openrouter']);
  const compat = matchingProviders(providers, ['openai-compat']);

  // Local dedup is per-kind: a configured Ollama (even on another host) covers
  // the discovered one; the Models tab remains the place for a second server.
  const savedLocal = providers.filter((p) => isLocalProvider(p.kind));
  const savedFor = (d: ProviderConfig) => providers.find((p) => p.kind === d.kind);
  const extraLocal = savedLocal.filter((p) => !found.some((d) => d.kind === p.kind));

  const addLocal = async (d: ProviderConfig) => {
    setAddingId(d.id);
    try {
      // A saved provider could share the probe's deterministic id (kind-local)
      // for a different server - give this add its own id rather than overwrite.
      const cfg = providers.some((p) => p.id === d.id) ? { ...d, id: `${d.kind}-${Date.now().toString(36)}` } : d;
      await window.nekko.saveProvider(cfg);
      setTests((m) => ({ ...m, [cfg.id]: { state: 'testing' } }));
      const r = await window.nekko
        .testProvider(cfg.id)
        .catch((e) => ({ ok: false, message: (e as Error).message }));
      setTests((m) => ({ ...m, [cfg.id]: { state: 'done', ...r } }));
      await refresh();
      pushToast(
        r.ok ? 'success' : 'info',
        r.ok ? `${cfg.label} added and connected.` : `${cfg.label} added, but the connect test failed: ${r.message}`,
      );
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setAddingId(null);
    }
  };

  const testSaved = async (id: string) => {
    setTests((m) => ({ ...m, [id]: { state: 'testing' } }));
    const r = await window.nekko
      .testProvider(id)
      .catch((e) => ({ ok: false, message: (e as Error).message }));
    setTests((m) => ({ ...m, [id]: { state: 'done', ...r } }));
  };

  // "Nekko Agent (this app)" is a deep link: close the wizard and land on Model
  // Server, which is where the engine, the model library and the folders other
  // apps already keep models in all live.
  const openModels = () => {
    const go = () => setView('modelserver');
    if (onExit) onExit(go);
    else {
      setOnboardingOpen(false);
      go();
    }
  };

  return (
    <div className="w-full">
      <h1 className="text-center text-2xl font-semibold tracking-tight">Connect a model</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-ink-soft">
        Nekko Agent chats through providers you connect: a ChatGPT subscription, an API key,
        or a local server like Ollama or LM Studio.
      </p>

      <section className="mt-6 w-full">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--info)' }} />
          <h2 className="text-base font-semibold">Online</h2>
        </div>
        <p className="mt-0.5 text-xs text-ink-faint">
          Subscriptions first, so you run on a plan you already pay for instead of a metered key.
        </p>
        <div className="mt-3 space-y-2">
          <OnlineCard
            title="ChatGPT / OpenAI"
            blurb="Runs on a ChatGPT Plus, Pro, or Business subscription, or an OpenAI API key billed per token."
            connected={chatgpt}
          >
            <SubscriptionSignIn
              oauthProvider="chatgpt"
              label="Sign in with ChatGPT"
              onConnected={connectSubscription('chatgpt', chatgptModel)}
            />
            <label className="mt-3 block text-xs font-medium text-ink-soft">
              Custom model id (optional)
              <input
                className="input mt-1 text-xs"
                value={chatgptModel}
                onChange={(e) => setChatgptModel(e.target.value)}
                placeholder="Override the curated list, e.g. gpt-5-codex"
              />
            </label>
            <ApiKeyDisclosure kind="openai" onSaved={refresh} />
          </OnlineCard>
          {/* Claude runs on an Anthropic API key. Claude plan sign-in is only offered
              if its approved-client slot is ever filled; the Claude Agent card
              (runs the user's installed Claude Code) joins here in the harness UI step. */}
          <OnlineCard
            title="Claude"
            blurb={
              claudeSignIn
                ? 'Sign in with your Claude account, or use an Anthropic API key billed per token.'
                : 'Use an Anthropic API key, billed per token to your Anthropic account.'
            }
            connected={claude}
          >
            {claudeSignIn ? (
              <>
                <SubscriptionSignIn
                  oauthProvider="claude"
                  label="Sign in with Claude"
                  onConnected={connectSubscription('claude')}
                />
                <ApiKeyDisclosure kind="anthropic" apiKeyOnly onSaved={refresh} />
              </>
            ) : (
              <div className="mt-3">
                <AddProvider fixedKind="anthropic" apiKeyOnly bare onDone={refresh} />
              </div>
            )}
          </OnlineCard>
          <OnlineCard
            title="OpenRouter"
            blurb="One API key, every hosted model - billed per token through OpenRouter."
            connected={openrouter}
          >
            <AddProvider fixedKind="openrouter" bare onDone={refresh} />
          </OnlineCard>
          <OnlineCard
            title="Other OpenAI-compatible"
            blurb="Any endpoint that speaks the OpenAI API: a gateway, a proxy, or a server you run elsewhere."
            connected={compat}
          >
            <AddProvider fixedKind="openai-compat" optionalKey bare onDone={refresh} />
          </OnlineCard>
        </div>
      </section>

      <section className="mt-6 w-full">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--success)' }} />
          <h2 className="text-base font-semibold">Local</h2>
        </div>
        <p className="mt-0.5 text-xs text-ink-faint">
          Model servers on this machine: private, free, and fast.
        </p>
        <div className="mt-3 space-y-2">
          {scan === 'scanning' && (
            <p className="rounded-xl border border-dashed p-4 text-xs text-ink-faint" style={{ borderColor: 'var(--line)' }}>
              Checking for Ollama, LM Studio, and vLLM on localhost…
            </p>
          )}
          {scan === 'failed' && (
            <p className="rounded-xl border border-dashed p-4 text-xs text-ink-faint" style={{ borderColor: 'var(--line)' }}>
              Couldn't scan automatically. Models can discover local servers too.
            </p>
          )}
          {scan === 'done' && found.length === 0 && extraLocal.length === 0 && (
            <p className="rounded-xl border border-dashed p-4 text-xs text-ink-faint" style={{ borderColor: 'var(--line)' }}>
              No local servers found on the usual ports. Start Ollama, LM Studio, or vLLM and they'll
              show up here next time.
            </p>
          )}
          {found.map((d) => (
            <LocalServerRow
              key={d.id}
              title={PROVIDER_DEFAULTS[d.kind].label}
              baseUrl={d.baseUrl}
              saved={savedFor(d)}
              candidate={d}
              adding={addingId === d.id}
              test={tests[(savedFor(d) ?? d).id]}
              onAdd={() => void addLocal(d)}
              onTest={(id) => void testSaved(id)}
            />
          ))}
          {extraLocal.map((p) => (
            <LocalServerRow
              key={p.id}
              title={p.label}
              baseUrl={p.baseUrl}
              saved={p}
              test={tests[p.id]}
              onAdd={() => {}}
              onTest={(id) => void testSaved(id)}
            />
          ))}
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--line)' }}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">
                  Nekko Agent <span className="font-normal text-ink-faint">(this app)</span>
                </h3>
                <p className="mt-0.5 text-xs text-ink-faint">
                  Run models here, with nothing else installed. Model Server downloads the engine, and picks up
                  anything Ollama or LM Studio already pulled onto this machine.
                </p>
              </div>
              <button className="btn btn-outline shrink-0 py-1 text-xs" onClick={openModels}>
                Open Model Server
              </button>
            </div>
          </div>
        </div>
      </section>

      <DefaultOffer providers={providers} />

      <p className="mt-6 text-center text-xs text-ink-faint">
        You can add or tune providers any time in Models.
      </p>
    </div>
  );
}

/**
 * The connected summary names the saved provider and how it authenticates, so
 * an OpenAI API key under the shared "ChatGPT / OpenAI" card doesn't read as a
 * subscription. Labels written by the subscription flow already carry the
 * "(subscription)" suffix, so the mode is only added when it isn't spelled out.
 */
function describeConnection(p: ProviderConfig): string {
  const mode = p.auth === 'subscription' ? 'subscription' : p.apiKey ? 'API key' : null;
  return mode && !p.label.includes(`(${mode})`) ? `${p.label} (${mode})` : p.label;
}

/**
 * One online option: a collapsed summary row that expands into its connect UI.
 * Once a provider of the card's kind exists it reads as connected and the add
 * UI is replaced, so the wizard can't create a duplicate.
 */
function OnlineCard({
  title,
  blurb,
  connected,
  children,
}: {
  title: string;
  blurb: string;
  connected: ProviderConfig[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isConnected = connected.length > 0;
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            {isConnected && (
              <Badge tone="success" variant="soft">
                <CheckIcon className="h-3 w-3" /> Connected
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">
            {isConnected ? connected.map(describeConnection).join(' · ') : blurb}
          </p>
        </div>
        {!isConnected && (
          <button
            className="btn btn-outline shrink-0 py-1 text-xs"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Close' : 'Set up'}
          </button>
        )}
      </div>
      {!isConnected && open && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A detected (or already configured) local model server: one-click Add for new
 * finds, a Test button once it's in the provider list.
 */
function LocalServerRow({
  title,
  baseUrl,
  saved,
  candidate,
  adding = false,
  test,
  onAdd,
  onTest,
}: {
  title: string;
  baseUrl: string;
  saved?: ProviderConfig;
  candidate?: ProviderConfig;
  adding?: boolean;
  test?: TestState;
  onAdd: () => void;
  onTest: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ServerIcon className="h-3.5 w-3.5 text-ink-faint" />
            <h3 className="text-sm font-semibold">{title}</h3>
            {saved && (
              <Badge tone="success" variant="soft">
                <CheckIcon className="h-3 w-3" /> Connected
              </Badge>
            )}
          </div>
          <p className="mt-0.5 font-mono text-2xs text-ink-faint">{baseUrl}</p>
        </div>
        {saved ? (
          <button
            className="btn btn-ghost shrink-0 px-2 py-1 text-xs"
            onClick={() => onTest(saved.id)}
            disabled={test?.state === 'testing'}
          >
            {test?.state === 'testing' ? 'Testing…' : 'Test'}
          </button>
        ) : (
          <button className="btn btn-primary shrink-0 py-1 text-xs" onClick={onAdd} disabled={adding}>
            {adding ? 'Adding…' : 'Add'}
          </button>
        )}
      </div>
      {test?.state === 'done' && (
        <p className="mt-2 text-xs" style={{ color: test.ok ? 'var(--success)' : 'var(--danger)' }}>
          {test.ok ? 'Connected' : test.message}
        </p>
      )}
      {candidate && !saved && (
        <p className="mt-1 text-2xs text-ink-faint">Detected running on this machine.</p>
      )}
    </div>
  );
}

/**
 * The quiet API-key fallback behind a subscription card's "billed per token"
 * disclosure. `apiKeyOnly` keeps the shared add form to just the key path.
 */
function ApiKeyDisclosure({ kind, apiKeyOnly = false, onSaved }: { kind: ProviderKind; apiKeyOnly?: boolean; onSaved: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="mt-2 text-xs text-ink-faint hover:text-ink" onClick={() => setOpen(true)}>
        Use an API key instead (billed per token)
      </button>
    );
  }
  return (
    <div className="mt-3">
      <AddProvider fixedKind={kind} apiKeyOnly={apiKeyOnly} bare onDone={onSaved} />
    </div>
  );
}

/**
 * "Use as default": once at least one provider is connected, offer to make it
 * the default for new chats (defaultProviderId/defaultModelId via
 * updateSettings). A saved default is stated, not re-asked, with a Change link.
 */
function DefaultOffer({ providers }: { providers: ProviderConfig[] }) {
  const settings = useStore((s) => s.settings);
  const pushToast = useStore((s) => s.pushToast);
  const current = settings?.defaultProviderId
    ? providers.find((p) => p.id === settings.defaultProviderId)
    : undefined;
  const [choosing, setChoosing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [picked, setPicked] = useState('');
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelId, setModelId] = useState('');
  const [saving, setSaving] = useState(false);

  // The picker's provider: whatever was last picked, falling back to the first
  // connected one (providers refresh in as they're added).
  const pid = picked && providers.some((p) => p.id === picked) ? picked : (providers[0]?.id ?? '');
  // With no saved default the offer is the picker itself; with one it waits
  // behind "Change".
  const showPicker = !dismissed && (!current || choosing);

  // Load the chosen provider's model list so the default can be pinned to a
  // specific model; an empty list just means "no default model".
  useEffect(() => {
    if (!showPicker || !pid) return;
    let alive = true;
    setModels(null);
    setModelId('');
    window.nekko
      .listModels(pid)
      .then((m) => {
        if (!alive) return;
        setModels(m);
        setModelId(m[0]?.id ?? '');
      })
      .catch(() => {
        if (alive) setModels([]);
      });
    return () => {
      alive = false;
    };
  }, [showPicker, pid]);

  if (providers.length === 0) return null;

  const setDefault = async () => {
    if (!pid || saving) return;
    setSaving(true);
    try {
      const next = await window.nekko.updateSettings({
        defaultProviderId: pid,
        ...(modelId ? { defaultModelId: modelId } : {}),
      });
      useStore.setState({
        settings: next,
        activeProviderId: pid,
        ...(modelId ? { activeModelId: modelId } : {}),
      });
      pushToast('success', 'Default saved. New chats will use it.');
      setChoosing(false);
      setDismissed(true);
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (current && !choosing) {
    return (
      <p className="mt-6 text-center text-xs text-ink-faint">
        New chats default to{' '}
        <span className="text-ink-soft">
          {current.label}
          {settings?.defaultModelId ? ` · ${settings.defaultModelId}` : ''}
        </span>
        .{' '}
        <button className="text-accent hover:underline" onClick={() => setChoosing(true)}>
          Change
        </button>
      </p>
    );
  }

  if (!showPicker) return null;

  const provider = providers.find((p) => p.id === pid);

  return (
    <div className="card mt-6 p-4">
      <h3 className="text-sm font-semibold">Use one as your default?</h3>
      <p className="mt-0.5 text-xs text-ink-faint">
        New chats start on your default provider and model.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-xs font-medium text-ink-soft">
          Provider
          <select className="input mt-1" value={pid} onChange={(e) => setPicked(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-soft">
          Model
          <select
            className="input mt-1"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={models === null}
          >
            {models === null ? (
              <option value="">Loading…</option>
            ) : models.length === 0 ? (
              <option value="">None listed</option>
            ) : (
              <>
                <option value="">Ask per chat</option>
                {models.map((m) => {
                  const price = provider
                    ? formatModelPriceLabel({ modelId: m.id, auth: provider.auth, isLocal: isLocalProvider(provider.kind), pricing: modelPricing(m) })
                    : undefined;
                  return (
                    <option key={m.id} value={m.id}>
                      {m.name}{price ? ` · ${price}` : ''}
                    </option>
                  );
                })}
              </>
            )}
          </select>
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          className="btn btn-ghost py-1 text-xs"
          onClick={() => (current ? setChoosing(false) : setDismissed(true))}
          disabled={saving}
        >
          {current ? 'Cancel' : 'Not now'}
        </button>
        <button className="btn btn-primary py-1 text-xs" onClick={() => void setDefault()} disabled={saving || !pid}>
          {saving ? 'Saving…' : 'Use as default'}
        </button>
      </div>
    </div>
  );
}

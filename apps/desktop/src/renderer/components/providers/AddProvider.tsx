import React, { useState } from 'react';
import type { OAuthProvider, OAuthStatus, ProviderConfig, ProviderKind } from '@nekko-agent/shared';
import { PROVIDER_DEFAULTS } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { SubscriptionSignIn } from '../SubscriptionSignIn.js';
import { ProviderChoices } from './ProviderChoices.js';
import { CheckIcon } from '../../icons.js';

/** Provider kinds offered by the generic add form, local servers first. */
export const ADD_PROVIDER_KINDS: ProviderKind[] = [
  'ollama',
  'lmstudio',
  'vllm',
  'anthropic',
  'chatgpt',
  'openai',
  'openrouter',
  'openai-compat',
];

/** Provider kinds whose primary path is a sign-in flow, mapped to the OAuth
 *  provider they sign in through. OpenRouter's "sign-in" mints an API key —
 *  it stays metered, unlike the two real subscriptions. */
export const SUBSCRIPTION_KINDS: Partial<Record<ProviderKind, OAuthProvider>> = {
  anthropic: 'claude',
  chatgpt: 'chatgpt',
  openrouter: 'openrouter',
};

/**
 * The already-configured providers a card or flow for `kinds` should treat as
 * connected, so nothing gets added twice.
 */
export function matchingProviders(providers: ProviderConfig[], kinds: ProviderKind[]): ProviderConfig[] {
  return providers.filter((p) => kinds.includes(p.kind));
}

/**
 * The ProviderConfig a completed subscription sign-in persists as. The status
 * the renderer gets is sanitized (a tokenKey, never a token); the host injects
 * the fresh access token at request time.
 */
export function subscriptionProviderConfig(
  status: OAuthStatus,
  opts: { kind?: ProviderKind; label?: string; baseUrl?: string; customModelId?: string } = {},
): ProviderConfig {
  // OpenRouter sign-in yields a metered API key: auth 'apikey' keeps the price
  // labels and billing copy honest; the key itself lives under tokenKey.
  if (status.provider === 'openrouter' || opts.kind === 'openrouter') {
    return {
      id: `openrouter-${Date.now().toString(36)}`,
      kind: 'openrouter',
      label: opts.label || 'OpenRouter',
      baseUrl: opts.baseUrl || PROVIDER_DEFAULTS.openrouter.baseUrl,
      auth: 'apikey',
      tokenKey: status.tokenKey,
      accountId: status.accountId,
      enabled: true,
    };
  }
  const chatgpt = status.provider === 'chatgpt' || opts.kind === 'chatgpt';
  const kind: ProviderKind = chatgpt ? 'chatgpt' : 'anthropic';
  return {
    id: `${kind}-${Date.now().toString(36)}`,
    kind,
    label: opts.label || (chatgpt ? 'ChatGPT (subscription)' : 'Claude (subscription)'),
    baseUrl: opts.baseUrl || PROVIDER_DEFAULTS[kind].baseUrl,
    auth: 'subscription',
    tokenKey: status.tokenKey,
    accountId: status.accountId,
    customModelId: chatgpt ? opts.customModelId?.trim() || undefined : undefined,
    enabled: true,
  };
}

/**
 * The ProviderConfig an existing card keeps after an in-place sign-in resets
 * its credential ("Reconnect" on a failing cloud card). Identity stays (id,
 * label, baseUrl, custom model override); the fresh sign-in token replaces
 * the stale one and the plain `apiKey` field is cleared (`apiKey: undefined`
 * survives neither structured clone nor the settings JSON, so the stored
 * record ends up keyless on purpose): a card that reconnects on a plan is a
 * plan card now, so auth flips to 'subscription'. OpenRouter is the exception
 * on both counts: its sign-in mints a metered key, so auth stays 'apikey'.
 */
export function reconnectProviderConfig(provider: ProviderConfig, status: OAuthStatus): ProviderConfig {
  return {
    ...provider,
    auth: provider.kind === 'openrouter' ? 'apikey' : 'subscription',
    apiKey: undefined,
    tokenKey: status.tokenKey || provider.tokenKey,
    accountId: status.accountId ?? provider.accountId,
  };
}

/**
 * The add-provider form, shared between the Models tab and the onboarding
 * wizard. By default it offers every kind with a type picker; `fixedKind` pins
 * one kind and hides the picker (the wizard's per-provider cards), `apiKeyOnly`
 * skips the subscription block for kinds that have one (the wizard's "use an
 * API key instead" fallback), `optionalKey` shows an optional key field for
 * kinds that don't require one (remote OpenAI-compatible endpoints often do),
 * and `bare` drops the card chrome so the caller can frame it.
 */
export function AddProvider({
  onDone,
  fixedKind,
  apiKeyOnly = false,
  optionalKey = false,
  bare = false,
  onCancel,
}: {
  onDone: () => void;
  fixedKind?: ProviderKind;
  apiKeyOnly?: boolean;
  optionalKey?: boolean;
  bare?: boolean;
  onCancel?: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [kind, setKind] = useState<ProviderKind>(fixedKind ?? 'ollama');
  const [label, setLabel] = useState(fixedKind ? PROVIDER_DEFAULTS[fixedKind].label : '');
  const [baseUrl, setBaseUrl] = useState(PROVIDER_DEFAULTS[fixedKind ?? 'ollama'].baseUrl);
  const [apiKey, setApiKey] = useState('');
  // For Anthropic the subscription sign-in is the primary path; the API key
  // field hides behind a quiet disclosure until the user asks for it. ChatGPT
  // is subscription-only, so it has no API-key disclosure at all. `apiKeyOnly`
  // is for surfaces (the wizard) that already present the subscription path
  // themselves and embed this form purely as the key fallback.
  const [useApiKey, setUseApiKey] = useState(apiKeyOnly);
  // Free-text ChatGPT model override, for model ids not in the curated list.
  const [customModelId, setCustomModelId] = useState('');
  // Anthropic workspace for an organization-level API key; a key created
  // inside a workspace leaves it blank.
  const [workspaceId, setWorkspaceId] = useState('');
  const oauthProvider = apiKeyOnly ? undefined : SUBSCRIPTION_KINDS[kind];

  const pick = (k: ProviderKind) => {
    setResult(null);
    setKind(k);
    setBaseUrl(PROVIDER_DEFAULTS[k].baseUrl);
    setLabel(PROVIDER_DEFAULTS[k].label);
    setUseApiKey(false);
    setApiKey('');
    setCustomModelId('');
    setWorkspaceId('');
  };

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // A completed sign-in only hands back a sanitized status (tokenKey, not the
  // token). The provider saves with auth: 'subscription'; the host injects the
  // fresh access token at request time.
  const connectSubscription = async (status: OAuthStatus) => {
    const chatgpt = status.provider === 'chatgpt' || kind === 'chatgpt';
    try {
    await window.nekko.saveProvider(
      subscriptionProviderConfig(status, { kind, label, baseUrl, customModelId }),
    );
    pushToast(
      'success',
      status.provider === 'openrouter'
        ? 'OpenRouter key connected.'
        : `Signed in with your ${chatgpt ? 'ChatGPT' : 'Claude'} subscription.`,
    );
    onDone();
    } catch (error) {
      setResult({ ok: false, message: `Could not save connection: ${String(error)}` });
    }
  };

  const draft = (): ProviderConfig => ({
    id: `${kind}-${Date.now().toString(36)}`,
    kind,
    label: label || PROVIDER_DEFAULTS[kind].label,
    baseUrl,
    apiKey: apiKey || undefined,
    workspaceId: kind === 'anthropic' ? workspaceId.trim() || undefined : undefined,
    enabled: true,
  });

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await window.nekko.testProviderConfig(draft()));
    } catch (error) {
      setResult({ ok: false, message: String(error) });
    } finally { setTesting(false); }
  };

  const save = async () => {
    setTesting(true);
    try {
      const config = draft();
      const check = await window.nekko.testProviderConfig(config);
      setResult(check);
      if (!check.ok) return;
      await window.nekko.saveProvider(config);
      onDone();
    } catch (error) {
      setResult({ ok: false, message: String(error) });
    } finally { setTesting(false); }
  };

  return (
    <div className={bare ? undefined : 'card mt-5 p-5'}>
      <div className="grid grid-cols-2 gap-3">
        {!fixedKind && (
          <div className="col-span-2"><ProviderChoices value={kind} onPick={pick} /></div>
        )}
        <details className="col-span-2">
          <summary className="cursor-pointer text-[12px] text-ink-soft">Connection settings{ oauthProvider ? ' (optional)' : ' — server address and name'}</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-[12px] font-medium text-ink-soft">
          Label
          <input className="input mt-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={PROVIDER_DEFAULTS[kind].label} />
        </label>
        <label className="text-[12px] font-medium text-ink-soft">
          Base URL
          <input className="input mt-1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
          </div>
        </details>
        {oauthProvider && (
          <div className="col-span-2 rounded-xl border p-4" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
            <p className="text-[13px] font-medium">
              {oauthProvider === 'openrouter'
                ? 'Connect with OpenRouter sign-in'
                : `Use your ${oauthProvider === 'claude' ? 'Claude' : 'ChatGPT'} subscription`}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-faint">
              {oauthProvider === 'claude'
                ? 'Sign in with your Claude Pro or Max account to run on your existing plan, with no API usage fees.'
                : oauthProvider === 'chatgpt'
                  ? 'Sign in with your ChatGPT Plus, Pro, or Business account to run on your existing plan, with no API usage fees.'
                  : 'Approving in the browser creates a key on your OpenRouter account and saves it here — no copy-pasting. Or paste a key below instead.'}
            </p>
            <div className="mt-2.5">
              <SubscriptionSignIn oauthProvider={oauthProvider} onConnected={connectSubscription} />
            </div>
            {kind === 'chatgpt' && (
              <label className="mt-3 block text-[12px] font-medium text-ink-soft">
                Custom model id (optional)
                <input
                  className="input mt-1 text-[12px]"
                  value={customModelId}
                  onChange={(e) => setCustomModelId(e.target.value)}
                  placeholder="Override the curated list, e.g. gpt-5-codex"
                />
              </label>
            )}
          </div>
        )}
        {(PROVIDER_DEFAULTS[kind].needsKey || optionalKey) && (kind !== 'anthropic' || useApiKey) && (
          <label className="col-span-2 text-[12px] font-medium text-ink-soft">
            API key{optionalKey && !PROVIDER_DEFAULTS[kind].needsKey ? ' (optional)' : ''}
            <input className="input mt-1" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
          </label>
        )}
        {kind === 'anthropic' && useApiKey && (
          <label className="col-span-2 text-[12px] font-medium text-ink-soft">
            Workspace ID (optional)
            <input
              className="input mt-1 text-[12px]"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="wrkspc_…"
            />
            <span className="mt-1 block font-normal text-ink-faint">
              Only for an organization-level key. A key created inside a workspace needs none.
            </span>
          </label>
        )}
        {kind === 'anthropic' && !apiKeyOnly && (
          <button
            className="col-span-2 justify-self-start text-[12px] text-ink-faint hover:text-ink"
            onClick={() => setUseApiKey((v) => !v)}
          >
            {useApiKey ? 'Back to subscription sign-in' : 'Use an API key instead (billed per token)'}
          </button>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="min-w-0 text-[12px]">
          {result && (
            <span style={{ color: result.ok ? 'var(--success)' : 'var(--danger)' }} className="inline-flex items-center gap-1.5">
              {result.ok && <CheckIcon className="h-3.5 w-3.5" />}
              {result.ok ? 'Connected' : result.message}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button className="btn btn-ghost" onClick={onCancel ?? onDone}>Cancel</button>
          {/* For Anthropic the subscription sign-in completes the add itself;
              test/save only make sense once the API-key path is revealed.
              ChatGPT has no API-key path, so its sign-in always completes.
              OpenRouter keeps both paths: sign in, or paste a key and save. */}
          {(oauthProvider === undefined || kind === 'openrouter' || (kind === 'anthropic' && useApiKey)) && (
            <>
              <button className="btn btn-outline" onClick={test} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button className="btn btn-primary" onClick={save} disabled={testing}>Connect provider</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

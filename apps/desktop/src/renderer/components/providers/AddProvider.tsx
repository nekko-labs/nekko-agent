import React, { useState } from 'react';
import type { OAuthProvider, OAuthStatus, ProviderConfig, ProviderKind } from '@nekko-agent/shared';
import { PROVIDER_DEFAULTS, oauthProviderOffered } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { SubscriptionSignIn } from '../SubscriptionSignIn.js';
import { ProviderChoices } from './ProviderChoices.js';
import { CLOUD_PROVIDER_PRESETS, KEY_SOURCES, SETUP_LINES, providerSetupDefaults, vertexEndpoint, type ProviderSetupKind } from './providerPresets.js';
import { CheckIcon } from '../../icons.js';
import { QuietTabs } from '../primitives/Quiet.js';
import { KeyFlow, type KeyCheck } from './KeyFlow.js';
import { ProviderMark } from './ProviderMark.js';
import { CLAUDE_API_KINDS, ClaudeSetup, isClaudeKind, type ClaudeChoice, type ClaudeConnected } from '../claude/ClaudeSetup.js';

/** Provider kinds offered by the generic add form, local servers first. */
export const ADD_PROVIDER_KINDS: ProviderKind[] = [
  'ollama',
  'lmstudio',
  'vllm',
  'anthropic',
  'claude-code',
  'bedrock',
  'vertex',
  'foundry',
  'chatgpt',
  'openai',
  'openrouter',
  'openai-compat',
];

/** Provider kinds whose primary path is a sign-in flow, mapped to the OAuth
 *  provider they sign in through. OpenRouter's "sign-in" mints an API key —
 *  it stays metered, unlike a real subscription. Anthropic is an API-key kind:
 *  Claude sign-in is only offered once its approved-client slot
 *  (`CLAUDE_APPROVED_CLIENT`) is filled, which it is not. */
/** Where a Claude API account lives, as the API form's choices name it. */
const API_SOURCE: Partial<Record<ProviderKind, string>> = {
  anthropic: 'Anthropic API key',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
};

export const SUBSCRIPTION_KINDS: Partial<Record<ProviderKind, OAuthProvider>> = {
  ...(oauthProviderOffered('claude') ? { anthropic: 'claude' as const } : {}),
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
  initialKind,
  apiKeyOnly = false,
  optionalKey = false,
  bare = false,
  onCancel,
  scope = 'all',
}: {
  onDone: () => void;
  fixedKind?: ProviderSetupKind;
  /** Preselect a kind but keep the picker (a notice's action). */
  initialKind?: ProviderSetupKind;
  apiKeyOnly?: boolean;
  optionalKey?: boolean;
  bare?: boolean;
  onCancel?: () => void;
  scope?: 'all' | 'cloud' | 'local';
}) {
  const pushToast = useStore((s) => s.pushToast);
  const startKind = fixedKind ?? initialKind;
  const [choice, setChoice] = useState<ProviderSetupKind>(startKind ?? (scope === 'cloud' ? 'gemini' : 'ollama'));
  const defaults = providerSetupDefaults(choice);
  const kind = defaults.kind;
  const preset = choice in CLOUD_PROVIDER_PRESETS ? CLOUD_PROVIDER_PRESETS[choice as keyof typeof CLOUD_PROVIDER_PRESETS] : undefined;
  const [label, setLabel] = useState(startKind ? providerSetupDefaults(startKind).label : '');
  const [baseUrl, setBaseUrl] = useState(defaults.baseUrl);
  const [googleProject, setGoogleProject] = useState('');
  const [googleLocation, setGoogleLocation] = useState('global');
  const [apiKey, setApiKey] = useState('');
  // Where a kind has both a sign-in and an API key (Anthropic, if Claude
  // sign-in is ever offered), the sign-in is the primary path and the key
  // field hides behind a quiet disclosure. ChatGPT is subscription-only, so it
  // has no API-key disclosure at all. `apiKeyOnly` is for surfaces (the
  // wizard) that already present the subscription path themselves and embed
  // this form purely as the key fallback.
  const [useApiKey, setUseApiKey] = useState(apiKeyOnly);
  // Anthropic workspace for an organization-level API key; a key created
  // inside a workspace leaves it blank.
  const [workspaceId, setWorkspaceId] = useState('');
  const oauthProvider = apiKeyOnly ? undefined : SUBSCRIPTION_KINDS[kind];

  // Claude is one choice: Subscription (Claude Code) or API, whose form opens
  // from the API column's Connect button. The wizard's API-key-only Claude
  // card keeps the plain form.
  const claude = isClaudeKind(kind) && kind !== 'vertex' && !apiKeyOnly;
  const [claudeApiOpen, setClaudeApiOpen] = useState(false);
  const [claudeConnected, setClaudeConnected] = useState<ClaudeConnected | null>(null);
  const chooseClaude = (c: ClaudeChoice) => {
    setResult(null);
    if (c === 'subscription') {
      setChoice('claude-code');
    } else if (!CLAUDE_API_KINDS.includes(kind)) {
      pickFields('anthropic');
    }
  };
  const showFields = !claude || (kind !== 'claude-code' && claudeApiOpen);

  const pickFields = (k: ProviderKind) => {
    setChoice(k);
    setBaseUrl(providerSetupDefaults(k).baseUrl);
    setLabel(providerSetupDefaults(k).label);
    setApiKey('');
    setKeyCheck({ state: 'idle' });
    setWorkspaceId('');
  };

  const pick = (k: ProviderSetupKind) => {
    setResult(null);
    setClaudeApiOpen(false);
    setClaudeConnected(null);
    setChoice(k);
    setBaseUrl(providerSetupDefaults(k).baseUrl);
    setLabel(providerSetupDefaults(k).label);
    setUseApiKey(apiKeyOnly);
    setApiKey('');
    setKeyCheck({ state: 'idle' });
    setWorkspaceId('');
    setGoogleProject('');
    setGoogleLocation('global');
  };

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  // The guided key flow's own progress: checking, failed, connected.
  const [keyCheck, setKeyCheck] = useState<KeyCheck>({ state: 'idle' });

  // A completed sign-in only hands back a sanitized status (tokenKey, not the
  // token). The provider saves with auth: 'subscription'; the host injects the
  // fresh access token at request time.
  const connectSubscription = async (status: OAuthStatus) => {
    const chatgpt = status.provider === 'chatgpt' || kind === 'chatgpt';
    try {
    await window.nekko.saveProvider(
      subscriptionProviderConfig(status, { kind, label, baseUrl }),
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

  const draft = (key = apiKey): ProviderConfig => ({
    id: `${choice}-${Date.now().toString(36)}`,
    kind,
    label: label || defaults.label,
    baseUrl,
    apiKey: key.trim() || undefined,
    auth: preset || KEY_SOURCES[choice] ? 'apikey' : undefined,
    workspaceId: kind === 'anthropic' ? workspaceId.trim() || undefined : undefined,
    enabled: true,
  });

  const validInput = (key = apiKey) => {
    const message = preset && !key.trim() ? `Enter your ${preset.label} API key.`
      : kind === 'vertex' && (!googleProject.trim() || !/^[a-z0-9-]+$/.test(googleProject.trim()) || !/^[a-z0-9-]+$/.test(googleLocation.trim())) ? 'Enter a Google Cloud project ID and a valid location.' : undefined;
    if (message) { setResult({ ok: false, message }); return false; }
    return true;
  };

  const test = async () => {
    if (!validInput()) return;
    setTesting(true);
    setResult(null);
    try {
      setResult(await window.nekko.testProviderConfig(draft()));
    } catch (error) {
      setResult({ ok: false, message: String(error) });
    } finally { setTesting(false); }
  };

  /** Check, then save. `key` comes from the key flow, which may run before its state lands. */
  const save = async (key = apiKey) => {
    if (!validInput(key)) return;
    const guided = keySource !== undefined;
    setTesting(true);
    if (guided) setKeyCheck({ state: 'checking' });
    try {
      const config = draft(key);
      const check = await window.nekko.testProviderConfig(config);
      if (!check.ok) {
        const message = check.message || `Could not connect ${config.label}.`;
        if (guided) setKeyCheck({ state: 'failed', message });
        else { setResult(check); pushToast('error', message); }
        return;
      }
      await window.nekko.saveProvider(config);
      pushToast('success', `${config.label} connected.`);
      if (claude) {
        // Stay on the Claude panel so the user sees it connected.
        setClaudeConnected({ title: 'Claude is connected', detail: `Using ${config.label} (${API_SOURCE[config.kind] ?? 'API'}), billed to that account.` });
        setClaudeApiOpen(false);
        setResult(null);
        setKeyCheck({ state: 'idle' });
        await useStore.getState().refreshProviders();
        return;
      }
      if (guided) {
        // Let the last step show its check before the panel closes.
        setKeyCheck({ state: 'connected' });
        setTimeout(onDone, 900);
        return;
      }
      setResult(check);
      onDone();
    } catch (error) {
      const message = String(error);
      if (guided) setKeyCheck({ state: 'failed', message });
      else { setResult({ ok: false, message }); pushToast('error', `Could not save: ${message}`); }
    } finally { setTesting(false); }
  };

  // Where the kind has a sign-in, the key flow waits behind "Use a key instead".
  const signInFirst = oauthProvider !== undefined && !useApiKey;
  const keySource = showFields && defaults.needsKey && !signInFirst ? KEY_SOURCES[choice] : undefined;
  const line = KEY_SOURCES[choice]?.line ?? SETUP_LINES[choice] ?? preset?.description;
  const title = kind === 'anthropic' && choice === 'anthropic' ? 'Claude API' : defaults.label;
  const plainKeyField = (defaults.needsKey || optionalKey) && !keySource && !signInFirst;

  return (
    <div className={bare ? 'min-w-0' : 'provider-setup-form min-w-0'}>
      <div className="flex min-w-0 flex-col gap-5">
        {!fixedKind && (
          <ProviderChoices value={claude ? 'anthropic' : choice} onPick={pick} scope={scope} />
        )}
        {!claude && !bare && (
          <div className="provider-setup-heading">
            <ProviderMark kind={choice} tile />
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{title}</h2>
              {line && <p className="text-xs text-ink-faint">{line}</p>}
            </div>
          </div>
        )}
        {claude && (
          <ClaudeSetup
            initialChoice={kind === 'claude-code' ? 'subscription' : CLAUDE_API_KINDS.includes(kind) && kind !== 'anthropic' ? 'api' : undefined}
            apiOpen={claudeApiOpen}
            connected={claudeConnected}
            onChoice={chooseClaude}
            onConnectApi={() => { setClaudeConnected(null); setClaudeApiOpen(true); }}
            onConnected={setClaudeConnected}
            onDone={onDone}
          />
        )}
        {claude && showFields && (
          <QuietTabs
            role="radiogroup"
            label="Where your Claude API account is"
            className="claude-api-kinds"
            value={kind}
            onChange={(k) => pickFields(k)}
            items={CLAUDE_API_KINDS.map((k) => ({ value: k, label: API_SOURCE[k] ?? k }))}
          />
        )}
        {showFields && <>
        {/* The heading already says what the sign-in is for; the button and its consent note are all that is left to say. */}
        {oauthProvider && !useApiKey && (
          <div className="min-w-0">
            <SubscriptionSignIn oauthProvider={oauthProvider} onConnected={connectSubscription} />
          </div>
        )}
        {kind === 'vertex' && <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="block min-w-0 text-xs font-medium text-ink-soft">Google Cloud project ID
              <input className="quiet-field mt-2" value={googleProject} placeholder="my-google-project" onChange={(e) => { setGoogleProject(e.target.value); setBaseUrl(vertexEndpoint(e.target.value, googleLocation)); }} />
            </label>
            <label className="block min-w-0 text-xs font-medium text-ink-soft">Google Cloud location
              <input className="quiet-field mt-2" value={googleLocation} placeholder="global" onChange={(e) => { setGoogleLocation(e.target.value); setBaseUrl(vertexEndpoint(googleProject, e.target.value)); }} />
            </label>
          </div>
          <div className="space-y-2">
            <p className="text-xs text-ink-soft">On the computer running Nekko Agent, sign in to Google:</p>
            <pre className="provider-setup-code">gcloud auth application-default login</pre>
            <a className="text-xs text-accent hover:underline" href="https://cloud.google.com/docs/authentication/provide-credentials-adc" target="_blank" rel="noreferrer" title="Or set GOOGLE_APPLICATION_CREDENTIALS on that computer. Enable Vertex AI and Claude in your project first. Nekko uses your Google credentials, never Claude Code credentials.">Other ways to sign in to Google</a>
          </div>
        </div>}
        {CLAUDE_API_KINDS.includes(kind) && <label className="min-w-0 text-xs font-medium text-ink-soft">
          Connection name
          <input className="quiet-field mt-2" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work API, Personal, or Client A" />
          <span className="mt-1 block text-2xs font-normal text-ink-faint">Its name in the model picker. Each API connection is billed separately.</span>
        </label>}
        {/* Before the key: the key flow connects as soon as a key lands. */}
        {kind === 'anthropic' && !signInFirst && (
          <label className="min-w-0 text-xs font-medium text-ink-soft">
            Workspace ID (optional)
            <input
              className="quiet-field mt-2"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="wrkspc_…"
            />
            <span className="mt-1 block font-normal text-ink-faint">
              Only for an organization-level key.
            </span>
          </label>
        )}
        {keySource && (
          <KeyFlow
            name={choice === 'anthropic' ? 'Anthropic' : defaults.label}
            source={keySource}
            value={apiKey}
            onChange={(k) => { setApiKey(k); if (keyCheck.state === 'failed') setKeyCheck({ state: 'idle' }); }}
            onConnect={(k) => void save(k)}
            check={keyCheck}
          />
        )}
        {plainKeyField && (
          <label className="min-w-0 text-xs font-medium text-ink-soft">
            API key{optionalKey && !defaults.needsKey ? ' (optional)' : ''}
            <input className="quiet-field mt-2" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={preset ? `${preset.label} API key` : 'sk-…'} />
          </label>
        )}
        {oauthProvider && defaults.needsKey && (
          <button
            type="button"
            className="self-start text-xs text-ink-soft hover:text-ink"
            onClick={() => { setUseApiKey((v) => !v); setKeyCheck({ state: 'idle' }); }}
          >
            {useApiKey ? (oauthProvider === 'openrouter' ? 'Sign in instead' : 'Back to subscription sign-in') : 'Use a key you already have'}
          </button>
        )}
        <details className="provider-setup-more min-w-0">
          <summary>Connection settings</summary>
          <div className="mt-4 grid grid-cols-2 gap-4">
            {!CLAUDE_API_KINDS.includes(kind) && <label className="min-w-0 text-xs font-medium text-ink-soft">
              Name
              <input className="quiet-field mt-2" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={defaults.label} />
            </label>}
            <label className="min-w-0 text-xs font-medium text-ink-soft">
              Server address
              <input className="quiet-field mt-2" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
          </div>
        </details>
        </>}
      </div>
      {/* Sign-ins and the key flow finish by themselves; only the plain forms
          (Vertex, Bedrock, Foundry, an OpenAI-compatible server, local
          servers) need Test and Connect. */}
      {(showFields && !keySource && !signInFirst) || onCancel ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-xs">
            {result && (
              <span className={`inline-flex items-center gap-2 ${result.ok ? 'text-success-text' : 'text-danger-text'}`} role={result.ok ? 'status' : 'alert'}>
                {result.ok && <CheckIcon className="h-3.5 w-3.5" />}
                {result.ok ? 'Connected' : result.message}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            {onCancel && <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
            {showFields && !keySource && !signInFirst && (
              <>
                <button className="btn" onClick={test} disabled={testing}>
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
                <button className="btn btn-primary" onClick={() => void save()} disabled={testing}>
                  {testing ? 'Connecting…' : 'Connect'}
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

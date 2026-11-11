import React, { useEffect, useState } from 'react';
import type { ConnectorConfig, ConnectorKind, ConnectorMeta, ConnectorResource, DetectedConnectors, RepoExclusions } from '@nekko-agent/shared';
import { CONNECTOR_CATALOG } from '@nekko-agent/shared';
import { ConnectorIcon } from '../connectorIcons.js';
import { CheckIcon } from '../icons.js';
import { StatusDot } from './primitives/index.js';
import { ConnectorRepos } from './ConnectorRepos.js';
import { exclusionsOf } from '../connectorRepos.js';
import { useStore } from '../store.js';

/** Step one of a setup: where the key comes from, as one button. */
interface KeySource {
  /** The button: "Create a token on GitHub". */
  action: string;
  /** One line under it. */
  hint: string;
  /** The page to open; `fields` lets a self-managed instance point at itself. */
  url: (fields: Record<string, string>) => string;
}

const at = (url: string) => () => url;

/** The token pages that take the name and scopes in the URL open with them filled in. */
export function githubTokenUrl(): string {
  return 'https://github.com/settings/tokens/new?description=Nekko%20Agent&scopes=repo,read:org';
}

export function gitlabTokenUrl(site?: string): string {
  const base = (site?.trim() || 'https://gitlab.com').replace(/\/+$/, '');
  return `${base}/-/user_settings/personal_access_tokens?name=Nekko%20Agent&scopes=api`;
}

export const KEY_SOURCE: Record<ConnectorKind, KeySource> = {
  github: { action: 'Create a token on GitHub', hint: 'The name and access are filled in. Press Generate token at the bottom, then copy it.', url: githubTokenUrl },
  gitlab: { action: 'Create a token on GitLab', hint: 'The name and the api scope are filled in. Press Create token, then copy it.', url: (f) => gitlabTokenUrl(f.site) },
  linear: { action: 'Create an API key in Linear', hint: 'Settings, Security & access, New API key.', url: at('https://linear.app/settings/api') },
  slack: { action: 'Get a token from your Slack app', hint: 'A bot or user token (xoxb- or xoxp-) with channels:read and search:read.', url: at('https://api.slack.com/apps') },
  discord: { action: 'Get a bot token from Discord', hint: 'Developer Portal, your app, Bot, Reset Token.', url: at('https://discord.com/developers/applications') },
  jira: { action: 'Create a Jira API token', hint: 'id.atlassian.com, Security, Create and manage API tokens.', url: at('https://id.atlassian.com/manage-profile/security/api-tokens') },
  teams: { action: 'Add an incoming webhook in Teams', hint: 'Channel, Manage channel, Connectors, Incoming Webhook. A Graph token is optional and enables reads.', url: at('https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook') },
  gmail: { action: 'Get an access token', hint: 'An OAuth token with gmail.readonly, from the OAuth Playground for now.', url: at('https://developers.google.com/oauthplayground') },
  gdrive: { action: 'Get an access token', hint: 'An OAuth token with drive.readonly, from the OAuth Playground for now.', url: at('https://developers.google.com/oauthplayground') },
  trello: { action: 'Get a Trello key and token', hint: 'Create a Power-Up for the API key, then generate a token on its page.', url: at('https://trello.com/power-ups/admin') },
  asana: { action: 'Create an Asana token', hint: 'Settings, Apps, Developer apps, Create new token.', url: at('https://app.asana.com/0/my-apps') },
  todoist: { action: 'Copy your Todoist token', hint: 'Settings, Integrations, Developer.', url: at('https://app.todoist.com/app/settings/integrations/developer') },
  clickup: { action: 'Copy your ClickUp token', hint: 'Settings, Apps, API Token (starts with pk_).', url: at('https://app.clickup.com/settings/apps') },
  tasksfile: { action: 'How task lists work', hint: 'Each "- [ ]" line shows as a task; "- [x]" lines are done.', url: at('https://docs.github.com/get-started/writing-on-github/working-with-advanced-formatting/about-task-lists') },
  floop: { action: 'Create a Floop API token', hint: 'Your Floop server, Settings, API tokens. An agent token shows Nekko Agent as itself.', url: at('https://github.com/nekko-labs/floop') },
};

interface ConnectorField {
  key: string;
  label: string;
  placeholder: string;
  /** Needed before the key can be fetched (a self-managed GitLab's address). */
  early?: boolean;
}

/**
 * Extra per-kind inputs a token alone can't cover. Jira's Basic auth needs the
 * site URL and the account email alongside the API token; a Teams incoming
 * webhook is a posting target rather than a read credential, so it lives in
 * settings while `token` stays the optional Graph token.
 */
const EXTRA_FIELDS: Partial<Record<ConnectorKind, ConnectorField[]>> = {
  jira: [
    { key: 'site', label: 'Site URL', placeholder: 'https://your-team.atlassian.net' },
    { key: 'email', label: 'Account email', placeholder: 'you@company.com' },
  ],
  gitlab: [{ key: 'site', label: 'Your own GitLab (optional)', placeholder: 'https://gitlab.com', early: true }],
  teams: [{ key: 'webhookUrl', label: 'Incoming webhook URL', placeholder: 'https://….webhook.office.com/…' }],
  trello: [{ key: 'key', label: 'API key', placeholder: 'your Power-Up API key' }],
  asana: [{ key: 'workspace', label: 'Workspace id (optional)', placeholder: 'first workspace' }],
  clickup: [{ key: 'team', label: 'Workspace id (optional)', placeholder: 'first workspace' }],
  tasksfile: [{ key: 'path', label: 'File path', placeholder: '/Users/you/project/TASKS.md' }],
  floop: [{ key: 'url', label: 'Server URL', placeholder: 'https://your-team.fly.dev' }],
};

/** Connectors whose repositories the user can choose (#2562). */
const GIT_KINDS: ReadonlySet<ConnectorKind> = new Set(['github', 'gitlab']);

/** Connectors that need no secret at all: there is no key step. */
const NO_TOKEN: ReadonlySet<ConnectorKind> = new Set(['tasksfile']);

const TOKEN_LABEL: Partial<Record<ConnectorKind, string>> = {
  github: 'GitHub token',
  gitlab: 'GitLab token',
  linear: 'Linear API key',
  slack: 'Slack token',
  discord: 'Discord bot token',
  jira: 'Jira API token',
  teams: 'Microsoft Graph token (optional)',
  trello: 'Trello token',
  floop: 'Floop API token',
};

/** How each service's keys start, so a pasted one can connect without another click. */
const TOKEN_SHAPE: Partial<Record<ConnectorKind, RegExp>> = {
  github: /^(ghp_|github_pat_|gho_|ghu_)[A-Za-z0-9_]{20,}$/,
  gitlab: /^glpat-[A-Za-z0-9_.-]{20,}$/,
  linear: /^lin_api_[A-Za-z0-9]{20,}$/,
  slack: /^xox[bp]-[A-Za-z0-9-]{20,}$/,
  clickup: /^pk_[A-Za-z0-9_]{20,}$/,
  floop: /^flp_[A-Za-z0-9_]{16,}$/,
};

/** Whether `text` is unmistakably a key for `kind`, so pasting it can connect at once. */
export function recognizesToken(kind: ConnectorKind, text: string): boolean {
  return TOKEN_SHAPE[kind]?.test(text.trim()) ?? false;
}

/** What a card needs before Connect lights up. */
export function canConnect(kind: ConnectorKind, token: string, fields: Record<string, string>): boolean {
  if (kind === 'jira') return Boolean(token && fields.site?.trim() && fields.email?.trim());
  // Either half of Teams is useful on its own: the webhook posts, the token reads.
  if (kind === 'teams') return Boolean(token || fields.webhookUrl?.trim());
  if (kind === 'trello') return Boolean(token && fields.key?.trim());
  if (kind === 'tasksfile') return Boolean(fields.path?.trim());
  if (kind === 'floop') return Boolean(token && fields.url?.trim());
  return Boolean(token);
}

/**
 * How far a card's setup has got: closed (just a Connect button), showing
 * where to get the key, or also asking for it. A connector without a key
 * skips straight to its fields.
 */
export type SetupStage = 'closed' | 'source' | 'paste';

export function firstStage(kind: ConnectorKind): SetupStage {
  return NO_TOKEN.has(kind) ? 'paste' : 'source';
}

/**
 * The connectors shared by the Connectors view and the onboarding
 * integrations step. Each starts as one row with one Connect button; pressing
 * it opens the steps one at a time (get the key, paste it), and the key field
 * appears only at the step that needs it. A GitHub CLI already signed in on
 * this computer connects GitHub in that one click. Connect stores the
 * credentials, then a real fetch decides whether they stay, so a bad token
 * surfaces immediately instead of silently "connecting".
 *
 * `compact` drops the sample-fetch area so the wizard stays skimmable;
 * everything still works from here or from the full Connectors tab later.
 */
export function ConnectorGrid({ compact = false }: { compact?: boolean }) {
  const [configs, setLocalConfigs] = useState<ConnectorConfig[]>([]);
  // Mirror into the store so surfaces keyed on connectors (the Agent Monitor's
  // Tasks section) appear or disappear as soon as one is connected.
  const setConfigs = (next: ConnectorConfig[]) => {
    setLocalConfigs(next);
    useStore.setState((s) => (s.settings ? { settings: { ...s.settings, connectors: next } } : {}));
  };
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<Record<string, Record<string, string>>>({});
  const [stages, setStages] = useState<Partial<Record<ConnectorKind, SetupStage>>>({});
  const [detected, setDetected] = useState<DetectedConnectors>({});
  const [preview, setPreview] = useState<Record<string, ConnectorResource[] | string | undefined>>({});
  const [busy, setBusy] = useState<ConnectorKind | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      const list = await window.nekko.listConnectors();
      setConfigs(list);
      // Only worth asking while GitHub is not connected yet. An older daemon
      // without the channel just means no one-click option.
      if (list.some((c) => c.kind === 'github' && c.connected)) return;
      try {
        setDetected((await window.nekko.detectConnectors?.()) ?? {});
      } catch {
        /* fall back to the token steps */
      }
    })();
  }, []);

  const isConnected = (k: ConnectorKind) => configs.find((c) => c.kind === k)?.connected;
  const stageOf = (k: ConnectorKind): SetupStage => stages[k] ?? 'closed';
  const setStage = (k: ConnectorKind, s: SetupStage) => setStages((p) => ({ ...p, [k]: s }));

  /** Stores the credentials (or the CLI sign-in), then keeps them only if a real fetch works. */
  const finish = async (k: ConnectorKind, store: () => Promise<unknown>) => {
    setBusy(k);
    setErrors((e) => ({ ...e, [k]: '' }));
    try {
      await store();
      const res = await window.nekko.fetchConnector(k);
      setConfigs(await window.nekko.listConnectors());
      setTokens((t) => ({ ...t, [k]: '' }));
      setFields((f) => ({ ...f, [k]: {} }));
      setStage(k, 'closed');
      setPreview((p) => ({ ...p, [k]: res }));
      return true;
    } catch (e) {
      await window.nekko.disconnectConnector(k);
      setConfigs(await window.nekko.listConnectors());
      setErrors((er) => ({ ...er, [k]: (e as Error).message || 'Could not connect, check the credentials.' }));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const connect = async (k: ConnectorKind, pasted?: string) => {
    const token = (pasted ?? tokens[k] ?? '').trim();
    const settings = fields[k];
    if (!canConnect(k, token, settings ?? {}) || busy) return;
    await finish(k, () => window.nekko.connectConnector(k, token, settings));
  };

  /** The row's Connect: one click with a detected sign-in, otherwise open the steps. */
  const start = async (k: ConnectorKind) => {
    if (busy) return;
    if (detected[k]) {
      const ok = await finish(k, () => window.nekko.importConnectorCli(k));
      if (!ok) {
        setDetected((d) => ({ ...d, [k]: undefined }));
        setStage(k, firstStage(k));
      }
      return;
    }
    setStage(k, firstStage(k));
  };

  const disconnect = async (k: ConnectorKind) => {
    setConfigs(await window.nekko.disconnectConnector(k));
    setPreview((p) => ({ ...p, [k]: undefined }));
  };

  /** Saves which repositories the app leaves out, showing the change at once. */
  const exclude = async (k: ConnectorKind, next: RepoExclusions) => {
    setConfigs(configs.map((c) => (c.kind === k ? { ...c, settings: { ...c.settings, ...next } } : c)));
    // A sample fetched before the change may list what was just removed.
    setPreview((p) => ({ ...p, [k]: undefined }));
    try {
      setConfigs(await window.nekko.excludeConnectorRepos(k, next));
    } catch (e) {
      setErrors((er) => ({ ...er, [k]: (e as Error).message || 'Could not save the repositories.' }));
      setConfigs(await window.nekko.listConnectors());
    }
  };

  const fetchData = async (k: ConnectorKind) => {
    try {
      const res = await window.nekko.fetchConnector(k);
      setPreview((p) => ({ ...p, [k]: res }));
    } catch (e) {
      setPreview((p) => ({ ...p, [k]: (e as Error).message }));
    }
  };

  return (
    <div className={compact ? 'grid grid-cols-1 gap-x-5 sm:grid-cols-2' : 'grid grid-cols-1 gap-x-5 @3xl:grid-cols-2 @6xl:grid-cols-3'}>
      {CONNECTOR_CATALOG.map((meta) => (
        <ConnectorRow
          key={meta.kind}
          meta={meta}
          compact={compact}
          connected={Boolean(isConnected(meta.kind))}
          stage={stageOf(meta.kind)}
          detected={detected[meta.kind]?.source === 'gh' ? detected[meta.kind]!.account : undefined}
          token={tokens[meta.kind] ?? ''}
          fields={fields[meta.kind] ?? {}}
          data={preview[meta.kind]}
          exclusions={GIT_KINDS.has(meta.kind) ? exclusionsOf(configs.find((c) => c.kind === meta.kind)) : undefined}
          onExclude={(next) => void exclude(meta.kind, next)}
          busy={busy === meta.kind}
          error={errors[meta.kind]}
          onStart={() => void start(meta.kind)}
          onStage={(s) => setStage(meta.kind, s)}
          onSkipCli={() => {
            setDetected((d) => ({ ...d, [meta.kind]: undefined }));
            setStage(meta.kind, firstStage(meta.kind));
          }}
          onToken={(v) => setTokens((t) => ({ ...t, [meta.kind]: v }))}
          onField={(key, v) => setFields((f) => ({ ...f, [meta.kind]: { ...f[meta.kind], [key]: v } }))}
          onConnect={(pasted) => void connect(meta.kind, pasted)}
          onDisconnect={() => void disconnect(meta.kind)}
          onFetch={() => void fetchData(meta.kind)}
        />
      ))}
    </div>
  );
}

export function ConnectorRow({
  meta,
  compact,
  connected,
  stage,
  detected,
  token,
  fields,
  data,
  busy,
  error,
  onStart,
  onStage,
  onSkipCli,
  onToken,
  onField,
  onConnect,
  onDisconnect,
  onFetch,
  exclusions,
  onExclude,
}: {
  meta: ConnectorMeta;
  compact: boolean;
  connected: boolean;
  stage: SetupStage;
  /** The GitHub CLI account ("" when GitHub did not name it), if one is signed in. */
  detected?: string;
  token: string;
  fields: Record<string, string>;
  data?: ConnectorResource[] | string;
  busy: boolean;
  error?: string;
  onStart: () => void;
  onStage: (s: SetupStage) => void;
  onSkipCli: () => void;
  onToken: (v: string) => void;
  onField: (key: string, v: string) => void;
  onConnect: (pasted?: string) => void;
  onDisconnect: () => void;
  onFetch: () => void;
  /** A git connector's removed repositories; the row then lists its repositories. */
  exclusions?: RepoExclusions;
  onExclude?: (next: RepoExclusions) => void;
}) {
  const kind = meta.kind;
  const open = !connected && stage !== 'closed';
  const extra = EXTRA_FIELDS[kind] ?? [];
  const source = KEY_SOURCE[kind];
  const needsToken = !NO_TOKEN.has(kind);
  const pasteStep = stage === 'paste';
  const ready = canConnect(kind, token.trim(), fields);
  const cli = detected !== undefined && !open && !connected;
  const field = (f: ConnectorField, autoFocus = false) => (
    <input
      key={f.key}
      className="input py-1 text-xs"
      aria-label={`${meta.label} ${f.label}`}
      placeholder={`${f.label}: ${f.placeholder}`}
      value={fields[f.key] ?? ''}
      onChange={(e) => onField(f.key, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onConnect();
      }}
      disabled={busy}
      autoFocus={autoFocus}
    />
  );

  const detail = connected ? (
    <span className="inline-flex items-center gap-1 text-ink-soft">
      <StatusDot tone="success" size={6} />
      Connected
    </span>
  ) : cli ? (
    `Ready: your GitHub CLI sign-in${detected ? ` as @${detected}` : ''}.`
  ) : (
    meta.description
  );

  return (
    <div className="min-w-0 py-1" data-connector={kind} data-stage={connected ? 'connected' : stage}>
      <div className="flex min-w-0 items-center gap-3 py-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center">
          <ConnectorIcon kind={kind} size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 'var(--q-tight)' }}>
          <span className="truncate text-sm font-medium">{meta.label}</span>
          <span className="truncate text-xs text-ink-faint" title={typeof detail === 'string' ? detail : undefined}>
            {detail}
          </span>
        </span>
        {connected ? (
          <span className="flex shrink-0 items-center gap-1">
            {!compact && (
              <button className="btn btn-ghost py-1 text-xs" onClick={onFetch}>
                Fetch sample
              </button>
            )}
            <button className="btn btn-ghost py-1 text-xs" onClick={onDisconnect}>
              Disconnect
            </button>
          </span>
        ) : open ? (
          <button className="btn btn-ghost shrink-0 py-1 text-xs" onClick={() => onStage('closed')} disabled={busy}>
            Cancel
          </button>
        ) : (
          <span className="flex shrink-0 items-center gap-1">
            {cli && (
              <button className="btn btn-ghost py-1 text-xs" onClick={onSkipCli} disabled={busy}>
                Use a token
              </button>
            )}
            <button className="btn py-1 text-xs" onClick={onStart} disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </span>
        )}
      </div>

      <div className={`collapse-wrap ${open ? '' : 'collapsed'}`} aria-hidden={!open}>
        <div className="min-h-0 overflow-hidden">
          {open && (
            <ol className="flex flex-col gap-4 pb-3 pt-1" style={{ paddingLeft: 48 }}>
              {needsToken && (
                <Step n={1} done={pasteStep} title={source.action} hint={source.hint}>
                  {extra.filter((f) => f.early).map((f) => field(f))}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className={`btn py-1 text-xs ${pasteStep ? 'btn-ghost' : 'btn-primary'}`}
                      onClick={() => {
                        window.nekko.openPath(source.url(fields));
                        onStage('paste');
                      }}
                    >
                      {pasteStep ? 'Open it again' : 'Open'}
                    </button>
                    {!pasteStep && (
                      <button className="btn btn-ghost py-1 text-xs" onClick={() => onStage('paste')}>
                        I already have one
                      </button>
                    )}
                  </div>
                </Step>
              )}
              {pasteStep && (
                <Step
                  n={needsToken ? 2 : 1}
                  title={needsToken ? 'Paste it here' : 'Point it at your file'}
                  hint={needsToken ? 'Pasting a key connects right away. It stays on this computer.' : source.hint}
                >
                  {extra.filter((f) => !f.early).map((f, i) => field(f, !needsToken && i === 0))}
                  <div className="flex items-center gap-2">
                    {needsToken && (
                      <input
                        className="input py-1 text-xs"
                        type="password"
                        aria-label={TOKEN_LABEL[kind] ?? `${meta.label} token`}
                        placeholder={TOKEN_LABEL[kind] ?? (meta.auth === 'oauth' ? 'OAuth access token' : 'API token')}
                        value={token}
                        autoFocus
                        onChange={(e) => onToken(e.target.value)}
                        onPaste={(e) => {
                          const pasted = e.clipboardData.getData('text').trim();
                          if (recognizesToken(kind, pasted) && canConnect(kind, pasted, fields)) {
                            e.preventDefault();
                            onToken(pasted);
                            onConnect(pasted);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onConnect();
                        }}
                        disabled={busy}
                      />
                    )}
                    <button className="btn btn-primary shrink-0 py-1 text-xs" disabled={busy || !ready} onClick={() => onConnect()}>
                      {busy ? 'Checking…' : 'Connect'}
                    </button>
                  </div>
                </Step>
              )}
            </ol>
          )}
        </div>
      </div>

      {error && (
        <p className="pb-2 text-2xs" style={{ color: 'var(--danger-text)', paddingLeft: 48 }} role="alert">
          {error}
        </p>
      )}

      {!compact && connected && exclusions && onExclude && <ConnectorRepos kind={kind} exclusions={exclusions} onChange={onExclude} />}

      {!compact && connected && data && (
        <div className="mb-2 max-h-40 space-y-1 overflow-y-auto" style={{ paddingLeft: 48 }}>
          {typeof data === 'string' ? (
            <p className="text-xs" style={{ color: 'var(--danger-text)' }}>
              {data}
            </p>
          ) : data.length === 0 ? (
            <p className="text-xs text-ink-faint">No results.</p>
          ) : (
            data.map((r) => (
              <div key={r.id} className="truncate text-xs">
                <span className="font-medium">{r.title}</span>
                {r.subtitle && <span className="text-ink-faint"> · {r.subtitle}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** One numbered step; a finished one shows a check instead of its number. */
function Step({ n, done = false, title, hint, children }: { n: number; done?: boolean; title: string; hint: string; children: React.ReactNode }) {
  return (
    <li className="flex min-w-0 flex-col gap-2 fade-in">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="w-4 shrink-0 text-xs tabular-nums text-ink-faint" aria-hidden>
          {done ? <CheckIcon className="h-3 w-3" /> : `${n}.`}
        </span>
        <span className="flex min-w-0 flex-col" style={{ gap: 'var(--q-tight)' }}>
          <span className={`text-xs font-medium ${done ? 'text-ink-soft' : ''}`}>{title}</span>
          {!done && <span className="text-2xs text-ink-faint">{hint}</span>}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-2" style={{ paddingLeft: 24 }}>
        {children}
      </div>
    </li>
  );
}

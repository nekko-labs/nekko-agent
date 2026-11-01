import React, { useEffect, useState } from 'react';
import type { ConnectorConfig, ConnectorKind, ConnectorMeta, ConnectorResource } from '@nekko-agent/shared';
import { CONNECTOR_CATALOG } from '@nekko-agent/shared';
import { ConnectorIcon } from '../connectorIcons.js';
import { Badge } from './primitives/index.js';
import { useStore } from '../store.js';

/** Where to get each connector's credentials, with a link to open. */
const HELP: Record<ConnectorKind, { hint: string; url: string }> = {
  github: { hint: 'Personal access token (fine-grained or classic) with repo read access, GitHub → Settings → Developer settings → Personal access tokens.', url: 'https://github.com/settings/tokens' },
  gitlab: { hint: 'Personal access token with the api scope, GitLab → Preferences → Access Tokens. Works for gitlab.com or a self-managed instance (set its URL below).', url: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
  linear: { hint: 'Personal API key, Linear → Settings → Security & access → New API key.', url: 'https://linear.app/settings/api' },
  slack: { hint: 'Bot/User OAuth token (xoxb-/xoxp-) with channels:read + search:read scopes.', url: 'https://api.slack.com/apps' },
  discord: { hint: 'Bot token, Discord Developer Portal → your app → Bot → Reset Token.', url: 'https://discord.com/developers/applications' },
  jira: { hint: 'API token for the account email above, id.atlassian.com → Security → Create and manage API tokens.', url: 'https://id.atlassian.com/manage-profile/security/api-tokens' },
  teams: { hint: 'Incoming webhook: Teams channel → ⋯ → Manage channel → Connectors → Incoming Webhook. Graph token (optional): Graph Explorer with Team.ReadBasic.All.', url: 'https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook' },
  gmail: { hint: 'OAuth access token with the gmail.readonly scope (one-click OAuth coming; for now grab a token from the OAuth Playground).', url: 'https://developers.google.com/oauthplayground' },
  gdrive: { hint: 'OAuth access token with the drive.readonly scope (one-click OAuth coming; for now grab a token from the OAuth Playground).', url: 'https://developers.google.com/oauthplayground' },
  trello: { hint: 'Create a Power-Up to get an API key, then generate a token from that key’s page.', url: 'https://trello.com/power-ups/admin' },
  asana: { hint: 'Personal access token, Asana → Settings → Apps → Developer apps → Create new token.', url: 'https://app.asana.com/0/my-apps' },
  todoist: { hint: 'API token, Todoist → Settings → Integrations → Developer.', url: 'https://app.todoist.com/app/settings/integrations/developer' },
  clickup: { hint: 'Personal API token (pk_…), ClickUp → Settings → Apps → API Token.', url: 'https://app.clickup.com/settings/apps' },
  tasksfile: { hint: 'Absolute path to a Markdown file. Each "- [ ] …" line shows as a task; "- [x]" lines are treated as done.', url: 'https://docs.github.com/get-started/writing-on-github/working-with-advanced-formatting/about-task-lists' },
  floop: { hint: 'API token (flp_…) from your Floop server, Settings → API tokens. Use an agent token so Nekko Agent shows as itself.', url: 'https://github.com/nekko-labs/floop' },
};

interface ConnectorField {
  key: string;
  label: string;
  placeholder: string;
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
  gitlab: [{ key: 'site', label: 'Instance URL (optional)', placeholder: 'https://gitlab.com' }],
  teams: [{ key: 'webhookUrl', label: 'Incoming webhook URL', placeholder: 'https://….webhook.office.com/…' }],
  trello: [{ key: 'key', label: 'API key', placeholder: 'your Power-Up API key' }],
  asana: [{ key: 'workspace', label: 'Workspace id (optional)', placeholder: 'first workspace' }],
  clickup: [{ key: 'team', label: 'Workspace id (optional)', placeholder: 'first workspace' }],
  tasksfile: [{ key: 'path', label: 'File path', placeholder: '/Users/you/project/TASKS.md' }],
  floop: [{ key: 'url', label: 'Server URL', placeholder: 'https://your-team.fly.dev' }],
};

/** Connectors that need no secret at all: the token input is hidden. */
const NO_TOKEN: ReadonlySet<ConnectorKind> = new Set(['tasksfile']);

const TOKEN_LABEL: Partial<Record<ConnectorKind, string>> = {
  jira: 'Jira API token',
  teams: 'Microsoft Graph token (optional, enables reads)',
  trello: 'Trello token',
  floop: 'Floop API token',
};

/** What a card needs before Connect lights up. */
function canConnect(kind: ConnectorKind, token: string, fields: Record<string, string>): boolean {
  if (kind === 'jira') return Boolean(token && fields.site?.trim() && fields.email?.trim());
  // Either half of Teams is useful on its own: the webhook posts, the token reads.
  if (kind === 'teams') return Boolean(token || fields.webhookUrl?.trim());
  if (kind === 'trello') return Boolean(token && fields.key?.trim());
  if (kind === 'tasksfile') return Boolean(fields.path?.trim());
  if (kind === 'floop') return Boolean(token && fields.url?.trim());
  return Boolean(token);
}

/**
 * The connector cards shared by the Connectors view and the onboarding
 * integrations step. Owns the whole connect → validate → preview cycle: Connect
 * stores the credentials, then a real fetch decides whether they stay, so a
 * bad token surfaces immediately instead of silently "connecting".
 *
 * `compact` drops the sample-fetch area and stacks the cards in a grid so the
 * wizard stays skimmable; everything still works from here or from the full
 * Connectors tab later.
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
  const [preview, setPreview] = useState<Record<string, ConnectorResource[] | string | undefined>>({});
  const [busy, setBusy] = useState<ConnectorKind | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = async () => setConfigs(await window.nekko.listConnectors());
  useEffect(() => {
    void load();
  }, []);

  const isConnected = (k: ConnectorKind) => configs.find((c) => c.kind === k)?.connected;

  const connect = async (k: ConnectorKind) => {
    const token = tokens[k]?.trim() ?? '';
    const settings = fields[k];
    if (!canConnect(k, token, settings ?? {}) || busy) return;
    setBusy(k);
    setErrors((e) => ({ ...e, [k]: '' }));
    try {
      await window.nekko.connectConnector(k, token, settings);
      const res = await window.nekko.fetchConnector(k);
      setConfigs(await window.nekko.listConnectors());
      setTokens((t) => ({ ...t, [k]: '' }));
      setFields((f) => ({ ...f, [k]: {} }));
      setPreview((p) => ({ ...p, [k]: res }));
    } catch (e) {
      await window.nekko.disconnectConnector(k);
      setConfigs(await window.nekko.listConnectors());
      setErrors((er) => ({ ...er, [k]: (e as Error).message || 'Could not connect, check the credentials.' }));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (k: ConnectorKind) => {
    setConfigs(await window.nekko.disconnectConnector(k));
    setPreview((p) => ({ ...p, [k]: undefined }));
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
    <div className={compact ? 'grid grid-cols-1 gap-3 sm:grid-cols-2' : 'grid grid-cols-1 gap-4 @3xl:grid-cols-2 @6xl:grid-cols-3'}>
      {CONNECTOR_CATALOG.map((meta) => (
        <ConnectorCard
          key={meta.kind}
          meta={meta}
          compact={compact}
          connected={Boolean(isConnected(meta.kind))}
          token={tokens[meta.kind] ?? ''}
          fields={fields[meta.kind] ?? {}}
          data={preview[meta.kind]}
          busy={busy === meta.kind}
          error={errors[meta.kind]}
          onToken={(v) => setTokens((t) => ({ ...t, [meta.kind]: v }))}
          onField={(key, v) => setFields((f) => ({ ...f, [meta.kind]: { ...f[meta.kind], [key]: v } }))}
          onConnect={() => void connect(meta.kind)}
          onDisconnect={() => void disconnect(meta.kind)}
          onFetch={() => void fetchData(meta.kind)}
        />
      ))}
    </div>
  );
}

function ConnectorCard({
  meta,
  compact,
  connected,
  token,
  fields,
  data,
  busy,
  error,
  onToken,
  onField,
  onConnect,
  onDisconnect,
  onFetch,
}: {
  meta: ConnectorMeta;
  compact: boolean;
  connected: boolean;
  token: string;
  fields: Record<string, string>;
  data?: ConnectorResource[] | string;
  busy: boolean;
  error?: string;
  onToken: (v: string) => void;
  onField: (key: string, v: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onFetch: () => void;
}) {
  const extra = EXTRA_FIELDS[meta.kind] ?? [];
  const help = HELP[meta.kind];
  return (
    <div className={`card ${compact ? 'p-4' : 'p-5'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: 'var(--surface-2)' }}>
            <ConnectorIcon kind={meta.kind} size={20} />
          </div>
          <div>
            <h3 className="font-semibold">{meta.label}</h3>
            <p className="text-xs text-ink-faint">{meta.description}</p>
          </div>
        </div>
        {connected && (
          <Badge tone="success" variant="solid">
            connected
          </Badge>
        )}
      </div>

      {connected ? (
        <div className="mt-3 flex justify-end gap-2">
          {!compact && (
            <button className="btn btn-outline py-1 text-xs" onClick={onFetch}>
              Fetch sample
            </button>
          )}
          <button className="btn btn-ghost py-1 text-xs" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      ) : (
        <div className="mt-3">
          {extra.map((f) => (
            <input
              key={f.key}
              className="input mb-2 py-1 text-xs"
              aria-label={`${meta.label} ${f.label}`}
              placeholder={`${f.label}: ${f.placeholder}`}
              value={fields[f.key] ?? ''}
              onChange={(e) => onField(f.key, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onConnect();
              }}
              disabled={busy}
            />
          ))}
          <div className="flex justify-end gap-2">
            {!NO_TOKEN.has(meta.kind) && <input
              className="input py-1 text-xs"
              type="password"
              placeholder={TOKEN_LABEL[meta.kind] ?? (meta.auth === 'oauth' ? 'OAuth access token' : 'API token')}
              value={token}
              onChange={(e) => onToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onConnect();
              }}
              disabled={busy}
            />}
            <button
              className="btn btn-primary py-1 text-xs"
              disabled={busy || !canConnect(meta.kind, token.trim(), fields)}
              onClick={onConnect}
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          <p className="mt-1 text-2xs text-ink-faint">
            {help.hint}{' '}
            <button className="text-accent hover:underline" onClick={() => window.nekko.openPath(help.url)}>
              Where to get it →
            </button>
          </p>
          {error && (
            <p className="mt-1 text-2xs" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}
        </div>
      )}

      {!compact && data && (
        <div className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-xl p-2" style={{ background: 'var(--surface-2)' }}>
          {typeof data === 'string' ? (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              {data}
            </p>
          ) : data.length === 0 ? (
            <p className="text-xs text-ink-faint">No results.</p>
          ) : (
            data.map((r) => (
              <div key={r.id} className="text-xs">
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

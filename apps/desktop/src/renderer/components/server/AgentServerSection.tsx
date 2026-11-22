import React, { useCallback, useEffect, useState } from 'react';
import type {
  AgentToolId,
  AgentToolStatus,
  ApiServerBind,
  ApiServerStatus,
  CliInstallStatus,
  SubagentSnippet,
} from '@nekko-agent/shared';
import {
  apiServerEnvLines,
  apiServerEnvLinesPowerShell,
  apiServerMcpConfig,
  apiServerRefusal,
  apiServerUrl,
} from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { Badge, StatusDot, Toggle } from '../primitives/index.js';
import { CheckIcon, ChevronIcon, CopyIcon, TerminalIcon } from '../../icons.js';
import { SettingsIcon } from '../../gentleface-icons.js';
import { SettingRow } from '../SettingsSection.js';

/**
 * The agent server, in Settings > Server: Nekko Agent as something other
 * programs can drive.
 *
 * Three answers to "how do I get at this from outside the window", building
 * on each other: a server on this machine, a CLI that talks to it, and an MCP
 * entry so other agents can. Installing the app sets all three up (loopback,
 * a generated token, the CLI linked onto PATH, MCP entries carrying both), so
 * the header is the whole answer most people need: is it running, where, and
 * the switch. Everything else waits behind Configure.
 *
 * It lived beside the model server on the Models page until the Models page
 * rework; it is a setting of this app, not of the models it runs.
 */

const POLL_MS = 4000;

export function AgentServerSection() {
  const pushToast = useStore((s) => s.pushToast);
  const [status, setStatus] = useState<ApiServerStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await window.nekko.apiServerStatus().catch(() => null));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!status) return null;

  const { settings, running } = status;
  // The web and self-hosted editions are already serving this page, so there is
  // nothing to switch on: the CLI and MCP groups still apply, the server one
  // says where it is instead of offering to start it.
  const canToggle = status.available !== false;

  const save = async (patch: Parameters<typeof window.nekko.apiServerSave>[0]) => {
    setBusy(true);
    const next = await window.nekko.apiServerSave(patch).catch((e: Error) => {
      pushToast('error', e.message);
      return null;
    });
    setBusy(false);
    if (next) {
      setStatus(next);
      if (next.error) pushToast('error', next.error);
    }
  };

  // What clients are told to use: the advertised address when one is set,
  // otherwise the bound one. Present even while stopped, because it describes
  // where the server *will* be.
  const url = status.clientUrl;
  const word = busy ? 'Working…' : running ? 'Running' : 'Stopped';

  return (
    <section id="agent-server" aria-labelledby="agent-server-heading" className="settings-section min-w-0" data-agent-server>
      {/* The switch reads `running` (is it listening) but flips `enabled`
          (should it be), which is the setting the backend acts on. */}
      <div className="flex min-w-0 items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 id="agent-server-heading" className="text-base font-semibold">Agent server</h2>
          <p className="mt-(--q-tight) text-xs text-ink-faint">
            Lets the <span className="font-mono">nekko-agent</span> CLI, scripts and other agents (over MCP) drive this app.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2" data-agent-server-status>
          <StatusDot tone={busy ? 'warning' : running ? 'success' : 'neutral'} />
          <span className="text-sm text-ink-soft">{canToggle ? word : 'Serving this page'}</span>
          {canToggle && (
            <Toggle
              value={running}
              onChange={() => void save({ enabled: !settings.enabled })}
              disabled={busy}
              label={running ? 'Stop the agent server' : 'Start the agent server'}
            />
          )}
        </div>
      </div>

      {running && (
        <div className="mt-(--q-inline) flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <CopyPill value={`${url}/api`} title="Copy the address other tools should point at" />
          <span className="text-xs text-ink-faint">
            {status.requests} request{status.requests === 1 ? '' : 's'}
            {status.clients > 0 ? ` · ${status.clients} listening` : ''}
          </span>
        </div>
      )}
      {status.error && <p className="mt-(--q-inline) text-xs text-danger-text">{status.error}</p>}
      {settings.bind === 'lan' && running && (
        <p className="mt-(--q-inline) text-xs text-warning-text">
          Reachable from your whole network on port {settings.port}. Anything with the token can run the agent,
          including its shell and file tools.
        </p>
      )}

      <button
        type="button"
        className="quiet-row mt-(--q-inline) -mx-2 flex w-[calc(100%+16px)] items-center gap-2 rounded-lg px-2 text-left"
        aria-expanded={open}
        aria-controls="agent-server-configure"
        data-agent-server-configure
        onClick={() => setOpen((v) => !v)}
      >
        <SettingsIcon className="h-4 w-4 shrink-0 text-ink-soft" />
        <span className="text-sm font-medium">Configure</span>
        <span className="min-w-0 truncate text-xs text-ink-faint">Address, token, CLI and MCP</span>
        <ChevronIcon className={`ml-auto h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-(--dur-med) ease-(--ease-out) ${open ? 'rotate-90' : ''}`} />
      </button>
      <div id="agent-server-configure" className={`collapse-wrap ${open ? '' : 'collapsed'}`} aria-hidden={!open}>
        <div className="min-h-0 overflow-hidden">
          {open && (
            <div className="space-y-(--q-group) pb-1 pl-6 pt-(--q-inline)">
              {canToggle && (
                <SettingRow
                  title="Start with Nekko"
                  detail="Bring the agent server up when the app opens."
                  control={
                    <Toggle
                      value={settings.startOnLaunch !== false}
                      onChange={(v) => void save({ startOnLaunch: v })}
                      disabled={busy}
                      label="Start the agent server with Nekko"
                    />
                  }
                />
              )}
              <div>
                <p className="quiet-group-label mb-(--q-heading)">Connection</p>
                {canToggle ? (
                  <ServerTab status={status} busy={busy} onSave={save} />
                ) : (
                  <p className="text-xs text-ink-soft">
                    This edition already is the Nekko Agent server: it is serving this page. Point the CLI and MCP
                    clients at <span className="font-mono">{url}</span> with the token that server was started with
                    (<span className="font-mono">NEKKO_TOKEN</span>).
                  </p>
                )}
              </div>
              <div>
                <p className="quiet-group-label mb-(--q-heading)">Command line</p>
                <CliTab running={running} />
              </div>
              <div>
                <p className="quiet-group-label mb-(--q-heading)">MCP clients</p>
                <McpTab url={url} token={settings.token} running={running} />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ServerTab({
  status,
  busy,
  onSave,
}: {
  status: ApiServerStatus;
  busy: boolean;
  onSave: (patch: Parameters<typeof window.nekko.apiServerSave>[0]) => Promise<void>;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [draft, setDraft] = useState(status.settings);
  const [revealed, setRevealed] = useState(false);
  const [shell, setShell] = useState<'posix' | 'powershell'>(() =>
    typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) ? 'powershell' : 'posix',
  );

  useEffect(() => setDraft(status.settings), [status.settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(status.settings);
  const refusal = apiServerRefusal({ ...draft, token: draft.token || 'pending' });
  const token = status.settings.token || '<generated when the server starts>';
  const lines = (t: string) =>
    shell === 'powershell' ? apiServerEnvLinesPowerShell(status.clientUrl, t) : apiServerEnvLines(status.clientUrl, t);
  // Shown masked like the token field above it (a screen share should not leak
  // it), copied in full, since the copy is the point.
  const env = lines(token);
  const shownEnv = revealed || !status.settings.token ? env : lines('•'.repeat(18));

  return (
    <div className="space-y-4">
      {/* Where it listens, and where clients are told to go. Two different
          questions behind a tunnel, a container or a Tailscale name, so two
          fields; the second is empty (= the first) almost always. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Reachable from"
          hint={
            draft.bind === 'lan'
              ? 'Anything on your network that has the token can run the agent here.'
              : draft.bind === 'custom'
                ? 'Listens on the one interface you name.'
                : 'Only this computer. The safe default.'
          }
        >
          <select
            className="input w-44 py-1 text-xs"
            value={draft.bind}
            aria-label="Reachable from"
            onChange={(e) => setDraft({ ...draft, bind: e.target.value as ApiServerBind })}
          >
            <option value="local">This computer only</option>
            <option value="lan">This computer and my network</option>
            <option value="custom">A specific address</option>
          </select>
        </Field>

        <Field label="Port" hint="Where the server listens.">
          <input
            type="number"
            className="input w-28 py-1 text-xs"
            min={1024}
            max={65535}
            aria-label="Port"
            value={draft.port}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
          />
        </Field>

        {draft.bind === 'custom' && (
          <Field label="Address to listen on" hint="An interface on this machine, e.g. 192.168.1.20 or ::1.">
            <input
              className="input w-44 py-1 font-mono text-xs"
              placeholder="192.168.1.20"
              aria-label="Address to listen on"
              value={draft.host ?? ''}
              onChange={(e) => setDraft({ ...draft, host: e.target.value })}
            />
          </Field>
        )}

        <Field
          label="Address clients use"
          hint="Only when it differs from where it listens: a tunnel, a container port, a Tailscale name."
        >
          <input
            className="input w-52 py-1 font-mono text-xs"
            placeholder={apiServerUrl(draft)}
            aria-label="Address clients use"
            value={draft.advertisedUrl ?? ''}
            onChange={(e) => setDraft({ ...draft, advertisedUrl: e.target.value })}
          />
        </Field>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs">Token</label>
          <div className="flex items-center gap-2">
            <code className="max-w-[220px] truncate rounded-md px-2 py-1 font-mono text-2xs" style={{ background: 'var(--surface-2)' }}>
              {status.settings.token ? (revealed ? status.settings.token : '•'.repeat(18)) : 'generated when it starts'}
            </code>
            {status.settings.token && (
              <>
                <button className="text-2xs text-ink-faint hover:text-ink" onClick={() => setRevealed((v) => !v)}>
                  {revealed ? 'Hide' : 'Show'}
                </button>
                <CopyPill value={status.settings.token} title="Copy the token" compact />
              </>
            )}
          </div>
        </div>
        <p className="mt-0.5 text-2xs text-ink-faint">
          Sent as <span className="font-mono">Authorization: Bearer …</span> on every request. There is no
          unauthenticated mode: this endpoint can run shell commands. Rolling it updates the CLI and the MCP entries
          this app wrote.
        </p>
        <button
          className="mt-1 text-xs text-ink-faint hover:text-ink"
          onClick={async () => {
            if (!window.confirm('Roll the token? Anything you configured by hand with the old one stops working.')) return;
            await window.nekko.apiServerNewToken();
            pushToast('success', 'New token. The CLI and the MCP entries this app wrote already have it.');
          }}
        >
          Roll the token
        </button>
      </div>

      {refusal && <p className="text-xs" style={{ color: 'var(--danger)' }}>{refusal}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary py-1 text-xs"
          onClick={() => onSave(draft)}
          disabled={!dirty || busy || !!refusal}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button className="btn btn-ghost py-1 text-xs" onClick={() => setDraft(status.settings)}>
            Discard
          </button>
        )}
      </div>

      {/* The environment, in one block with the address and token it is made
          of. The CLI and the MCP entries this app wrote find the server on
          their own; these lines are for pointing anything else at it. */}
      <div className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-ink-soft">Environment</p>
          <div className="flex gap-1">
            <TabButton active={shell === 'posix'} onClick={() => setShell('posix')}>bash / zsh</TabButton>
            <TabButton active={shell === 'powershell'} onClick={() => setShell('powershell')}>PowerShell</TabButton>
          </div>
        </div>
        <Command value={shownEnv.join('\n')} copyValue={env.join('\n')} />
        <p className="mt-1 text-2xs text-ink-faint">
          Not needed for the <span className="font-mono">nekko-agent</span> command or the MCP entries this app
          added: they read the address and token from the app. Use these for scripts and anything else.
        </p>
      </div>

      {status.lastRequestAt && (
        <p className="border-t pt-3 text-xs text-ink-faint" style={{ borderColor: 'var(--line)' }}>
          Last request {new Date(status.lastRequestAt).toLocaleTimeString()}.
        </p>
      )}
    </div>
  );
}

function CliTab({ running }: { running: boolean }) {
  const pushToast = useStore((s) => s.pushToast);
  const [cli, setCli] = useState<CliInstallStatus | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let alive = true;
    window.nekko
      .cliInstallStatus()
      .then((s) => alive && setCli(s))
      .catch(() => alive && setCli(null));
    return () => {
      alive = false;
    };
  }, []);

  const install = async () => {
    setInstalling(true);
    try {
      const next = await window.nekko.cliInstall();
      setCli(next);
      if (next.installed) {
        pushToast('success', next.needsRestart ? 'Installed. Open a new terminal to use it.' : 'Installed.');
      } else if (next.message) {
        pushToast('error', next.message);
      }
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const command = cli?.command ?? 'nekko-agent';
  const bundled = cli?.available !== false;

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-soft">
        The same agent, from a terminal. It drives this app while the server is on, and your local data directory
        when it is off.
      </p>

      {cli === null ? (
        <p className="text-xs text-ink-faint">Checking the command…</p>
      ) : bundled ? (
        <div className="flex min-h-(--q-row) flex-wrap items-center gap-2 py-(--q-inline)" data-quiet-row>
          <TerminalIcon className="h-4 w-4 shrink-0 text-ink-faint" />
          <span className="font-mono text-xs">nekko-agent</span>
          {cli.installed && cli.onPath ? (
            <Badge tone="success" variant="soft">On your PATH</Badge>
          ) : cli.installed ? (
            <span className="chip">{cli.needsRestart ? 'installed, open a new terminal' : 'installed, not on PATH'}</span>
          ) : (
            <span className="chip">not installed</span>
          )}
          <button className="btn btn-outline ml-auto py-1 text-xs" disabled={installing} onClick={install}>
            {installing ? 'Installing…' : cli.installed ? 'Reinstall' : 'Install'}
          </button>
          {cli.binDir && (
            <p className="w-full text-2xs text-ink-faint">
              Shipped inside the app and linked from <span className="font-mono">{cli.binDir}</span>. No Node or npm
              needed.
            </p>
          )}
          {cli.message && (
            <p className="w-full text-2xs" style={{ color: 'var(--warning)' }}>
              {cli.message}
            </p>
          )}
        </div>
      ) : (
        <Step n={1} label="Install it">
          <Command value="npm install -g nekko-agent" />
        </Step>
      )}

      <Step n={bundled ? 1 : 2} label="Use it">
        <Command
          value={[
            `${command} status`,
            `${command} chat "summarize the changes on this branch"`,
            `${command} sessions --json`,
          ].join('\n')}
        />
        {!running && (
          <p className="mt-1 text-2xs" style={{ color: 'var(--warning)' }}>
            The server is off, so these run against your local data directory instead of this window.
          </p>
        )}
      </Step>
      <p className="text-2xs text-ink-faint">
        <span className="font-mono">{command} --help</span> lists every command: sessions, workspaces, tasks, skills,
        scheduled tasks and training runs.
      </p>
    </div>
  );
}

function McpTab({ url, token, running }: { url: string; token: string; running: boolean }) {
  const pushToast = useStore((s) => s.pushToast);
  const [tools, setTools] = useState<AgentToolStatus[] | null>(null);
  const [installing, setInstalling] = useState<AgentToolId | null>(null);
  const [snippet, setSnippet] = useState<(SubagentSnippet & { id: AgentToolId }) | null>(null);
  const [cliCommand, setCliCommand] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    window.nekko
      .detectAgentTools()
      .then((list) => alive && setTools(list))
      .catch(() => alive && setTools([]));
    window.nekko
      .cliInstallStatus()
      .then((s) => alive && setCliCommand(s.installed ? s.binPath : undefined))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const install = async (id: AgentToolId) => {
    setInstalling(id);
    try {
      const res = await window.nekko.installSubagent(id);
      setTools(res.tools);
      pushToast(res.ok ? 'success' : 'error', res.ok
        ? `Added. Restart ${res.tools.find((t) => t.id === id)?.label ?? id} to pick it up.`
        : res.message ?? 'Install failed.');
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-soft">
        Nekko Agent is also an MCP server, so Claude Code, Codex, Cursor or Windsurf can use it as a subagent: your
        workspaces, skills and sessions become tools they can call. Each entry is written pointing at this app, with
        its address and token, and kept up to date when they change.
      </p>

      <div className="space-y-2">
        {tools === null && <p className="text-xs text-ink-faint">Checking which tools are installed…</p>}
        {tools?.length === 0 && (
          <p className="text-xs text-ink-faint">None of the supported tools are installed on this machine.</p>
        )}
        {tools?.map((t) => (
          <div key={t.id} className="flex min-h-(--q-row) flex-wrap items-center gap-2 py-(--q-inline)" data-quiet-row>
            <TerminalIcon className="h-4 w-4 shrink-0 text-ink-faint" />
            <span className="text-xs font-medium">{t.label}</span>
            {t.installed ? (
              <Badge tone="success" variant="soft">Added</Badge>
            ) : t.detected ? (
              <span className="chip">installed, not added</span>
            ) : (
              <span className="chip">not found</span>
            )}
            <span className="ml-auto flex items-center gap-2">
              <button
                className="text-xs text-ink-faint hover:text-ink"
                onClick={async () => {
                  const s = await window.nekko.subagentSnippet(t.id).catch(() => null);
                  setSnippet(s ? { ...s, id: t.id } : null);
                }}
              >
                Show snippet
              </button>
              {!t.installed && t.detected && (
                <button
                  className="btn btn-outline py-1 text-xs"
                  disabled={installing !== null}
                  onClick={() => install(t.id)}
                >
                  {installing === t.id ? 'Adding…' : 'Add'}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      {snippet && (
        <div>
          <p className="mb-1 text-2xs text-ink-faint">Paste into {snippet.target}</p>
          <Command value={snippet.snippet} />
        </div>
      )}

      <div className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
        <p className="mb-1 text-xs text-ink-soft">
          Anything else that speaks MCP takes this. With the server on it drives this window; without it, a separate
          copy on your data directory.
        </p>
        {/* Masked on screen, whole on copy, like the Server tab's env block. */}
        <Command
          value={apiServerMcpConfig(url, token ? '•'.repeat(18) : '<generated when the server starts>', cliCommand)}
          copyValue={apiServerMcpConfig(url, token || '<generated when the server starts>', cliCommand)}
        />
        {!running && (
          <p className="mt-1 text-2xs" style={{ color: 'var(--warning)' }}>
            The server is off, so the two env lines have nothing to reach yet.
          </p>
        )}
      </div>
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 flex items-center gap-2 text-xs font-medium text-ink-soft">
        <span
          className="grid h-4 w-4 place-items-center rounded-full text-2xs tabular-nums"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          {n}
        </span>
        {label}
      </p>
      {children}
    </div>
  );
}

/** A block of shell or JSON with a copy button, since that is what it is for. */
function Command({ value, copyValue }: { value: string; copyValue?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="group relative">
      <pre
        className="max-h-56 overflow-auto rounded-lg p-3 pr-9 font-mono text-2xs leading-relaxed"
        style={{ background: 'var(--surface-2)' }}
      >
        {value}
      </pre>
      <button
        className="absolute right-1.5 top-1.5 rounded-md p-1 text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 touch:opacity-100 focus:opacity-100"
        title="Copy"
        aria-label="Copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(copyValue ?? value);
            setCopied(true);
          } catch {
            /* clipboard denied, nothing worth surfacing */
          }
        }}
      >
        {copied ? (
          <span style={{ color: 'var(--success)' }}>
            <CheckIcon className="h-3.5 w-3.5" />
          </span>
        ) : (
          <CopyIcon className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

/** A value that is only useful in someone else's config, one click from there. */
function CopyPill({ value, title, compact = false }: { value: string; title: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className={`inline-flex items-center gap-2 rounded-full border ${compact ? 'px-2 py-0.5' : 'px-2 py-1'} font-mono text-2xs text-ink-faint hover:text-ink`}
      style={{ borderColor: 'var(--line)' }}
      title={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          /* clipboard denied */
        }
      }}
    >
      {!compact && value}
      {copied ? (
        <span style={{ color: 'var(--success)' }}>
          <CheckIcon className="h-3 w-3" />
        </span>
      ) : (
        <CopyIcon className="h-3 w-3" />
      )}
    </button>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="rounded-full px-3 py-1 text-xs"
      style={
        active
          ? { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }
          : { color: 'var(--ink-faint)' }
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs">{label}</label>
        {children}
      </div>
      <p className="mt-0.5 text-2xs text-ink-faint">{hint}</p>
    </div>
  );
}

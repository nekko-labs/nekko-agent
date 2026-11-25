import React, { useState } from 'react';
import type { HypergateInfo, McpServerConfig } from '@nekko-agent/shared';
import { HypergateIcon } from '../connectorIcons.js';
import { PlugIcon } from '../icons.js';
import { openSettingsGroup } from '../settingsIndex.js';
import { useStore } from '../store.js';
import { Group, StatusDot } from './primitives/index.js';

/** The MCP entry connecting saves the gateway as (`hypergate::ENTRY_ID` in the daemon). */
export const HYPERGATE_ENTRY_ID = 'hypergate';
const HYPERGATE_SITE = 'https://hypergate.app';

/**
 * Where the row's check has got. `idle` shows what is saved; the others are
 * the answer to the last Connect, Start or Check again.
 */
export type HypergatePhase = 'idle' | 'checking' | 'starting' | 'connecting' | 'missing' | 'stopped';

const BUSY: Partial<Record<HypergatePhase, string>> = {
  checking: 'Checking…',
  starting: 'Starting…',
  connecting: 'Connecting…',
};

const servers = (n: number) => `${n} server${n === 1 ? '' : 's'}`;

/**
 * The Hypergate row on the Connectors page. Connect first looks for
 * Hypergate on this computer, then says what it found: connected (when it
 * was running), installed but not running (with Start), or not installed
 * (with Get Hypergate). Presentational, so each state renders in a test.
 */
export function HypergateRow({
  phase, saved, info, error, onCheck, onStart, onOpen, onDisconnect,
}: {
  phase: HypergatePhase;
  /** The gateway is saved as an MCP entry, so this install is connected to it. */
  saved: boolean;
  /** The running daemon: undefined while probing, null when nothing answered. */
  info: HypergateInfo | null | undefined;
  error?: string;
  onCheck: () => void;
  onStart: () => void;
  onOpen: () => void;
  onDisconnect: () => void;
}) {
  const busy = BUSY[phase];
  const status = (tone: 'success' | 'warning' | 'neutral', words: string) => (
    <span className="flex min-w-0 items-center gap-1 text-ink-soft">
      <StatusDot tone={tone} size={6} />
      <span className="min-w-0 truncate" title={words}>{words}</span>
    </span>
  );
  const detail: React.ReactNode =
    phase === 'checking' ? 'Looking for Hypergate on this computer…'
    : phase === 'starting' ? 'Starting Hypergate…'
    : phase === 'connecting' ? 'Connecting to Hypergate…'
    : phase === 'missing' ? status('neutral', 'Not installed on this computer')
    : phase === 'stopped' ? status('warning', 'Installed, not running')
    : saved && info ? status('success', `Connected · v${info.version} · ${servers(info.servers)}`)
    : saved && info === null ? status('warning', 'Connected, but Hypergate is not running')
    : saved ? status('success', 'Connected')
    : 'Your MCP servers behind one endpoint, and your API keys in one local vault.';

  const actions = busy ? (
    <button className="btn py-1 text-xs" disabled>{busy}</button>
  ) : phase === 'missing' ? (
    <>
      <button className="btn btn-ghost py-1 text-xs" onClick={onCheck}>Check again</button>
      <button className="btn py-1 text-xs" onClick={() => window.nekko.openPath(HYPERGATE_SITE)}>Get Hypergate ↗</button>
    </>
  ) : phase === 'stopped' || (saved && info === null) ? (
    <>
      {saved
        ? <button className="btn btn-ghost py-1 text-xs" onClick={onDisconnect}>Disconnect</button>
        : <button className="btn btn-ghost py-1 text-xs" onClick={onCheck}>Check again</button>}
      <button className="btn py-1 text-xs" onClick={onStart}>Start Hypergate</button>
    </>
  ) : saved ? (
    <>
      {info && <button className="btn btn-ghost py-1 text-xs" onClick={onOpen}>Open</button>}
      <button className="btn btn-ghost py-1 text-xs" onClick={onDisconnect}>Disconnect</button>
    </>
  ) : (
    <button className="btn py-1 text-xs" onClick={onCheck}>Connect</button>
  );

  return (
    <div className="min-w-0 py-1" data-connector="hypergate" data-stage={saved && phase === 'idle' ? 'connected' : phase}>
      <div className="flex min-w-0 items-center gap-3 py-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center">
          <HypergateIcon size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 'var(--q-tight)' }}>
          <span className="truncate text-sm font-medium">Hypergate</span>
          <span key={phase} className="truncate text-xs text-ink-faint fade-in" title={typeof detail === 'string' ? detail : undefined}>
            {detail}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">{actions}</span>
      </div>
      {error && (
        <p className="pb-2 text-2xs" style={{ color: 'var(--danger-text)', paddingLeft: 48 }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The Hypergate row wired to the daemon and the app-wide pairing in the store. */
export function HypergateConnector() {
  const info = useStore((s) => s.hypergate);
  const saved = useStore((s) => (s.settings?.mcpServers ?? []).some((m) => m.id === HYPERGATE_ENTRY_ID));
  const [phase, setPhase] = useState<HypergatePhase>('idle');
  const [error, setError] = useState('');

  /** Keep what connecting taught us (the agent name) when the same daemon answers again. */
  const remember = (found: HypergateInfo | null) =>
    useStore.setState((s) => ({
      hypergate: found && s.hypergate?.port === found.port ? { ...s.hypergate, ...found } : found,
    }));

  const connect = async (port: number) => {
    setPhase('connecting');
    // A refusal is already a toast from the store; the row goes back to what is saved.
    await useStore.getState().connectHypergate(port);
    setPhase('idle');
  };

  /** Connect's first step: is Hypergate on this computer, and is it up? */
  const check = async () => {
    setPhase('checking');
    setError('');
    try {
      const found = await window.nekko.checkHypergate(info?.port);
      remember(found.info);
      if (found.info) await connect(found.info.port);
      else setPhase(found.installed ? 'stopped' : 'missing');
    } catch (e) {
      setError((e as Error).message || 'Could not look for Hypergate.');
      setPhase('idle');
    }
  };

  const start = async () => {
    setPhase('starting');
    setError('');
    try {
      const up = await window.nekko.startHypergate(info?.port);
      remember(up);
      if (up) await connect(up.port);
      else {
        setError('Hypergate did not answer after starting. Open it from your apps, then check again.');
        setPhase('stopped');
      }
    } catch (e) {
      setError((e as Error).message || 'Could not start Hypergate.');
      setPhase('stopped');
    }
  };

  const disconnect = async () => {
    const all = useStore.getState().settings?.mcpServers ?? [];
    await window.nekko.updateSettings({ mcpServers: all.filter((m) => m.id !== HYPERGATE_ENTRY_ID) });
    await useStore.getState().refreshSettings();
    setPhase('idle');
  };

  return (
    <HypergateRow
      phase={phase}
      saved={saved}
      info={info}
      error={error}
      onCheck={() => void check()}
      onStart={() => void start()}
      onOpen={() => useStore.getState().openHypergatePane()}
      onDisconnect={() => void disconnect()}
    />
  );
}

/** Where a server runs, without its arguments or token (they can hold secrets). */
export function mcpServerWhere(server: McpServerConfig): string {
  if (server.url) {
    try {
      return new URL(server.url).host;
    } catch {
      return 'Remote server';
    }
  }
  return server.command || 'Local server';
}

/**
 * The MCP servers group: what is configured in Settings, other than the
 * Hypergate gateway (it has its own row above). Adding and editing stay in
 * Settings; Manage jumps there.
 */
export function McpServersGroup({ list }: { list: McpServerConfig[] | undefined }) {
  const shown = (list ?? []).filter((m) => m.id !== HYPERGATE_ENTRY_ID);
  return (
    <Group
      title="MCP servers"
      actions={<button className="btn btn-ghost py-1 text-xs" onClick={() => openSettingsGroup('mcp-servers')}>Manage</button>}
    >
      {shown.length === 0 ? (
        <p className="text-xs text-ink-faint">No MCP servers yet. Manage adds one in Settings.</p>
      ) : (
        <div className="grid grid-cols-1 gap-x-5 @3xl:grid-cols-2 @6xl:grid-cols-3">
          {/* The connector rows' layout, so the names line up with the groups above. */}
          {shown.map((m) => (
            <div key={m.id} className="flex min-w-0 items-center gap-3 py-3" data-mcp-server={m.id}>
              <span className="grid h-9 w-9 shrink-0 place-items-center text-ink-soft">
                <PlugIcon className="h-4 w-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 'var(--q-tight)' }}>
                <span className={`truncate text-sm font-medium ${m.enabled ? '' : 'text-ink-faint'}`}>{m.name}</span>
                <span className="truncate text-xs text-ink-faint">{m.enabled ? mcpServerWhere(m) : 'Turned off in Settings'}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Group>
  );
}

/** `McpServersGroup` reading the configured servers from the store. */
export function ConfiguredMcpServers() {
  const list = useStore((s) => s.settings?.mcpServers);
  return <McpServersGroup list={list} />;
}

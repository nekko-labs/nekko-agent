/**
 * The local API server: Nekko Agent, reachable by other programs.
 *
 * The desktop app already holds everything worth driving — the providers, the
 * workspaces, the sessions with their history — and until now the only way in
 * was the window. Turning this on puts the same host behind `POST /api/:channel`
 * and a `/api/events` socket on this machine, which is the surface the CLI and
 * the MCP server already speak. So `nekko-agent chat "…"` in a terminal, or
 * Claude Code over MCP, talks to *this* app rather than to a second copy of it
 * running on the same files.
 *
 * On by default as of 0.8, because the CLI and the MCP entries are set up by
 * the installer and both of them are useless pointed at a port nothing is
 * listening on. Every *other* default is still the safe one: loopback only, a
 * token required, and a token generated rather than left empty.
 */

import { trimTrailingSlashes } from './trim.js';

/** Where the server listens: a preset, or an interface typed by hand. */
export type ApiServerBind = 'local' | 'lan' | 'custom';

/** What the local API server is configured to do. */
export interface ApiServerSettings {
  /** Serve now and keep serving: the live on/off switch. */
  enabled: boolean;
  /**
   * Whether the server comes up when the app launches.
   *
   * Separate from `enabled` because the two answer different questions:
   * `enabled` is "is it on right now", this is "should it be on when I open
   * the app". Off means every launch starts with the server stopped (and the
   * CLI link saying so) however it was left at quit, and the power button
   * still switches it on for the session. Missing reads as on, which is what
   * every install did before the setting existed.
   */
  startOnLaunch?: boolean;
  port: number;
  /**
   * `local` = 127.0.0.1 only. `lan` exposes it to the whole network. `custom`
   * binds whatever `host` names, for the machine with three interfaces and an
   * opinion about which one this belongs on.
   */
  bind: ApiServerBind;
  /** The interface to bind when `bind` is `custom`, e.g. `192.168.1.20`. */
  host?: string;
  /**
   * The address clients are told to use, when it isn't the one being bound.
   *
   * Binding and advertising are the same thing right up until something sits
   * in front: a container publishes 1439 under a different host, an SSH tunnel
   * moves the port, Tailscale gives the machine a name. The server still binds
   * `bind`/`port`; this is only what the CLI lines, the MCP config and the
   * copy button hand out. Empty means "whatever is being bound".
   */
  advertisedUrl?: string;
  /**
   * Required as `Authorization: Bearer <token>` on every request. Never empty
   * while the server is enabled: an unauthenticated agent endpoint is a remote
   * shell, and the one on a laptop's network is a remote shell for the café.
   */
  token: string;
}

/** Live state of the local API server, as the Models tab shows it. */
export interface ApiServerStatus {
  settings: ApiServerSettings;
  running: boolean;
  /**
   * Whether this edition can switch a server on at all. False in the web and
   * self-hosted editions, which *are* the server already: there is nothing to
   * start, and a toggle that admits that is better than one that does nothing.
   */
  available?: boolean;
  /** The base URL other tools point at, when it is up. */
  url?: string;
  /** Why it is not up, when it was asked to be. */
  error?: string;
  /**
   * The address to hand to clients: the advertised one when set, otherwise the
   * bound one. Present even while stopped, because the CLI and MCP blocks
   * describe where the server *will* be.
   */
  clientUrl: string;
  /** Open event sockets right now, so "is anything connected" has an answer. */
  clients: number;
  /**
   * Requests served since it started, and when the last one arrived. Proof the
   * thing at the other end actually reached it, which is the question anyone
   * wiring up a CLI is really asking.
   */
  requests: number;
  lastRequestAt?: number;
}

export const API_SERVER_PORT_DEFAULT = 1439;

export const DEFAULT_API_SERVER_SETTINGS: ApiServerSettings = {
  // On by default since 0.8: the CLI and the MCP entries are installed with
  // the app, and a CLI that only works once you have found a checkbox in
  // Settings is a CLI that does not work. Loopback and token-only, as before.
  enabled: true,
  startOnLaunch: true,
  port: API_SERVER_PORT_DEFAULT,
  bind: 'local',
  host: '',
  advertisedUrl: '',
  token: '',
};

/** The settings with anything missing filled in, for an install that predates them. */
export function withApiServerDefaults(settings: Partial<ApiServerSettings> | undefined): ApiServerSettings {
  return { ...DEFAULT_API_SERVER_SETTINGS, ...settings };
}

/** The interface these settings bind: what `listen()` is handed. */
export function apiServerBindHost(settings: ApiServerSettings): string {
  if (settings.bind === 'lan') return '0.0.0.0';
  if (settings.bind === 'custom') return settings.host?.trim() || '127.0.0.1';
  return '127.0.0.1';
}

/**
 * The base URL for the interface being bound.
 *
 * `0.0.0.0` is an interface, not an address anyone can dial, so a LAN bind is
 * quoted as this machine's address when the caller knows it and as loopback
 * otherwise, which at least works from here.
 */
export function apiServerUrl(settings: ApiServerSettings, host = '127.0.0.1'): string {
  const bound = apiServerBindHost(settings);
  const dialable = bound === '0.0.0.0' || bound === '::' ? host : bound;
  // A bare IPv6 address needs brackets before a port can follow it.
  const authority = dialable.includes(':') ? `[${dialable}]` : dialable;
  return `http://${authority}:${settings.port}`;
}

/**
 * Why these settings cannot be served, or null when they can.
 *
 * Checked in the shared package because both ends need the same answer: the UI
 * to say so before saving, and the host to refuse to listen regardless of what
 * the UI allowed through.
 */
export function apiServerRefusal(settings: ApiServerSettings): string | null {
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) {
    return 'Pick a port between 1024 and 65535.';
  }
  if (!settings.token.trim()) {
    return 'A token is required. Anything that can reach this port can otherwise run the agent.';
  }
  if (settings.bind === 'custom' && !settings.host?.trim()) {
    return 'Enter the address to bind, or pick one of the presets.';
  }
  const advertised = settings.advertisedUrl?.trim();
  if (advertised && !/^https?:\/\/[^\s/]+/i.test(advertised)) {
    return 'The address clients use must be a full URL, e.g. http://nekko.tailnet.ts.net:1439.';
  }
  return null;
}

/** The env two lines of shell need to point the CLI at this server. */
export function apiServerEnvLines(url: string, token: string): string[] {
  return [`export NEKKO_URL=${url}`, `export NEKKO_TOKEN=${token}`];
}

/** The same two, as Windows PowerShell sets them. */
export function apiServerEnvLinesPowerShell(url: string, token: string): string[] {
  return [`$env:NEKKO_URL = "${url}"`, `$env:NEKKO_TOKEN = "${token}"`];
}

/**
 * The MCP entry other agent tools need, as the JSON they paste.
 *
 * `command` is the bundled CLI when the app knows where it put one, and `npx`
 * otherwise: a machine that has Nekko Agent installed already has the CLI, and
 * pointing at it means the entry works offline and with no npm registry round
 * trip on every launch.
 */
export function apiServerMcpConfig(url: string, token: string, command?: string): string {
  return JSON.stringify({ mcpServers: { 'nekko-agent': mcpServerEntry(url, token, command) } }, null, 2);
}

/** One tool's MCP server entry: the command to run and the env it needs. */
export function mcpServerEntry(
  url: string,
  token: string,
  command?: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  const env: Record<string, string> = {};
  if (url) env.NEKKO_URL = url;
  if (token) env.NEKKO_TOKEN = token;
  const base = command ? { command, args: ['mcp'] } : { command: 'npx', args: ['-y', 'nekko-agent', 'mcp'] };
  // No env at all rather than an empty one, so an entry with nothing to point
  // at is byte-identical to the portable form tools already have.
  return Object.keys(env).length ? { ...base, env } : base;
}

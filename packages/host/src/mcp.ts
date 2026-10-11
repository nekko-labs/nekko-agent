import { assertHostExecution } from './indirect-execution-guard.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { ToolSpec } from '@nekko-agent/core';
import { brandEnv } from '@nekko-agent/shared';
import type { McpServerConfig, McpServerStatus, HypergateInfo, ToolResult, ToolCall } from '@nekko-agent/shared';
import { daemonCall } from './engine/daemon.js';
import { daemonOwns } from './daemon-loop.js';

/**
 * Minimal MCP client, hand-rolled so we add no dependency. Two transports:
 *   • stdio — JSON-RPC 2.0 over newline-delimited stdio of a spawned process.
 *   • streamable HTTP — JSON-RPC POSTed to a URL (e.g. a Hypergate gateway),
 *     used when the config carries `url`; handles JSON and SSE-framed replies
 *     and echoes the server's `mcp-session-id` for stateful servers.
 * One McpServer wraps one server: handshake, list tools, call tools.
 */
/** How long one streamable-HTTP MCP call may take before it is given up on. */
const HTTP_CALL_TIMEOUT_MS = 10 * 60_000;

class McpServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private url: string | undefined;
  private token: string | undefined;
  private sessionId: string | undefined;
  tools: Array<{ name: string; description?: string; inputSchema?: any }> = [];
  connected = false;
  error: string | undefined;

  async start(config: McpServerConfig): Promise<void> {
    if (config.url) {
      this.url = config.url;
      this.token = config.token;
    } else {
      this.proc = spawn(config.command, config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // npx and friends are .cmd shims on Windows → need a shell to resolve them.
        shell: process.platform === 'win32',
      }) as ChildProcessWithoutNullStreams;
      this.proc.stdout.on('data', (d) => this.onData(d));
      this.proc.stderr.on('data', () => {/* server logs, ignore */});
      this.proc.on('error', (e) => { this.error = e.message; this.connected = false; });
      this.proc.on('exit', () => { this.connected = false; });
    }

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nekko-agent', version: '1' },
    });
    this.notify('notifications/initialized');
    const res = await this.request('tools/list', {});
    this.tools = res?.tools ?? [];
    this.connected = true;
  }

  /** POST one JSON-RPC message to the streamable-HTTP endpoint and parse the reply. */
  private async httpSend(body: Record<string, unknown>, expectReply: boolean): Promise<any> {
    // A server that accepts the request and never answers held the tool call,
    // and with it the whole turn, for good. Ten minutes is generous for a tool.
    const res = await fetch(this.url!, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_CALL_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!expectReply) return undefined; // notifications → 202 Accepted, no body
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}${res.status === 401 ? ' (check the bearer token)' : ''}`);
    const ctype = res.headers.get('content-type') ?? '';
    let msg: any;
    if (ctype.includes('text/event-stream')) {
      // SSE-framed: find the event whose data carries our response id.
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim());
          if (parsed.id === body.id) { msg = parsed; break; }
        } catch { /* keep scanning */ }
      }
      if (!msg) throw new Error('MCP HTTP: no response in event stream');
    } else {
      msg = await res.json();
    }
    if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
    return msg.result;
  }

  private onData(d: Buffer): void {
    this.buffer += d.toString();
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message ?? 'MCP error')) : resolve(msg.result);
        }
      } catch {
        /* partial/non-JSON line */
      }
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    if (this.url) return this.httpSend({ jsonrpc: '2.0', id, method, params }, true);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP ${method} timed out`));
        }
      }, 20000);
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.url) { void this.httpSend({ jsonrpc: '2.0', method, params }, false).catch(() => {}); return; }
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(obj: unknown): void {
    try {
      this.proc?.stdin.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.request('tools/call', { name, arguments: args ?? {} });
  }

  stop(): void {
    try { this.proc?.kill(); } catch { /* already gone */ }
    this.url = undefined;
    this.sessionId = undefined;
    this.connected = false;
  }
}

const servers = new Map<string, McpServer>();

/**
 * The servers as the engine daemon last reported them, once it runs them
 * (`mcp:sync`, crates/nekkod/src/mcp.rs). The daemon keeps them alive across a
 * host restart and parses their output off this event loop; this side keeps
 * a snapshot so the tool list and status stay synchronous.
 */
interface DaemonMcp {
  specs: ToolSpec[];
  servers: Record<string, { connected: boolean; tools: Array<{ name: string; description?: string }>; error?: string }>;
}
let remote: DaemonMcp | null = null;

async function mcpDaemon() {
  const daemon = process.env.NEKKO_AGENT_LOOP === 'ts' ? undefined : daemonCall();
  return daemon && (await daemonOwns(daemon, 'mcp:sync')) ? daemon : undefined;
}

/** Reconcile running servers with the configured+enabled set (idempotent). */
export async function syncMcp(configs: McpServerConfig[]): Promise<void> {
  const daemon = await mcpDaemon();
  if (daemon) {
    remote = await daemon<DaemonMcp>('mcp:sync', configs);
    // Any this host started before the daemon took over.
    for (const srv of servers.values()) srv.stop();
    servers.clear();
    return;
  }
  remote = null;
  const want = new Map(configs.filter((c) => c.enabled).map((c) => [c.id, c]));
  // Stop servers no longer wanted.
  for (const [id, srv] of servers) {
    if (!want.has(id)) { srv.stop(); servers.delete(id); }
  }
  // Start newly-enabled servers.
  await Promise.all(
    [...want.values()]
      .filter((c) => !servers.has(c.id))
      .map(async (c) => {
        const srv = new McpServer();
        servers.set(c.id, srv);
        try {
          await srv.start(c);
        } catch (e) {
          srv.error = (e as Error).message;
        }
      }),
  );
}

/** Agent tool specs for every connected MCP tool, namespaced `mcp__<id>__<tool>`. */
export function mcpToolSpecs(): ToolSpec[] {
  if (remote) return remote.specs;
  const out: ToolSpec[] = [];
  for (const [id, srv] of servers) {
    for (const t of srv.tools) {
      out.push({
        name: `mcp__${id}__${t.name}`,
        description: t.description ? `(MCP) ${t.description}` : `(MCP) ${t.name}`,
        parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      });
    }
  }
  return out;
}

/**
 * What a daemon advertises in `daemon:info` `owned` when a turn it drives can
 * sync and call that turn's MCP servers itself (from `facts.mcpServers`),
 * approvals included, so an MCP call never round-trips through this host.
 */
export const DAEMON_MCP = 'turn:mcp';

export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__');
}

/** Lightweight {name, description} list of connected MCP tools (for the UI). */
export function mcpToolList(): Array<{ name: string; description: string }> {
  return mcpToolSpecs().map((t) => ({ name: t.name, description: t.description ?? '' }));
}

/** Route an `mcp__<id>__<tool>` call to the right server. */
export async function callMcpTool(call: ToolCall, sessionId?: string): Promise<ToolResult> {
  assertHostExecution(sessionId, 'MCP');
  if (remote) {
    const daemon = daemonCall();
    if (!daemon) return { toolCallId: call.id, output: 'The engine is not running.', isError: true };
    try {
      return await daemon<ToolResult>('mcp:call', call, sessionId);
    } catch (e) {
      return { toolCallId: call.id, output: `MCP call failed: ${(e as Error).message}`, isError: true };
    }
  }
  const parts = call.name.split('__');
  const id = parts[1];
  const tool = parts.slice(2).join('__');
  const srv = servers.get(id);
  if (!srv || !srv.connected) {
    return { toolCallId: call.id, output: `MCP server "${id}" is not connected.`, isError: true };
  }
  try {
    const res = await srv.callTool(tool, call.input as Record<string, unknown>);
    const text = Array.isArray(res?.content)
      ? res.content.map((c: any) => c?.text ?? JSON.stringify(c)).join('\n')
      : JSON.stringify(res);
    return { toolCallId: call.id, output: text || '(no output)', isError: !!res?.isError };
  } catch (e) {
    return { toolCallId: call.id, output: `MCP call failed: ${(e as Error).message}`, isError: true };
  }
}

// ── Hypergate (github.com/nekko-labs/hypergate) ─────────────────────────────
// The companion daemon that runs and supervises local MCP servers and puts
// them all behind one gateway endpoint. Everything here is host-side so it
// works in every edition (the browser can't always reach another localhost
// port) and so a deep link can connect without any view being mounted.

/** The port `hypergated` listens on unless it was told otherwise. */
export const DEFAULT_HYPERGATE_PORT = 7777;

/** The MCP entry id Hypergate gets in settings. Constant, so re-connecting replaces it. */
export const HYPERGATE_ENTRY_ID = 'hypergate';

/** `service` values a Hypergate daemon answers `/health` with. */
const HYPERGATE_SERVICES = ['hypergated'];

/**
 * The daemon's base URL.
 *
 * A caller-supplied port wins outright: it comes from a deep link naming a
 * specific daemon, and an environment default that quietly redirected it
 * elsewhere would connect to something other than what was clicked. The env
 * vars are only the answer to "where is Hypergate?" when nobody said.
 */
export const hypergateBase = (port?: number): string =>
  port
    ? `http://localhost:${port}`
    : (process.env.HYPERGATE_URL ?? brandEnv('MCP_URL') ?? `http://localhost:${DEFAULT_HYPERGATE_PORT}`);

/**
 * Probe for a running Hypergate daemon.
 *
 * Deliberately free of side effects, since it runs whenever Settings mounts and
 * whenever a link arrives: it reads state and never mints anything.
 * Connecting (below) is the step that creates something.
 */
export async function detectHypergate(port?: number): Promise<HypergateInfo | null> {
  const base = hypergateBase(port);
  try {
    const signal = AbortSignal.timeout(1500);
    const health = (await (await fetch(`${base}/health`, { signal })).json()) as
      { service?: string; version?: string; servers?: number };
    if (!HYPERGATE_SERVICES.includes(health?.service ?? '')) return null;
    const gw = (await (await fetch(`${base}/api/gateway`, { signal })).json()) as
      { url: string; uiUrl?: string };
    return {
      url: gw.url,
      uiUrl: gw.uiUrl ?? `${base}/`,
      servers: health.servers ?? 0,
      version: health.version ?? '?',
      port: portOf(base),
    };
  } catch {
    return null;
  }
}

/** The port a base URL points at, for the info we hand back to the UI. */
function portOf(base: string): number {
  try {
    const parsed = new URL(base);
    return Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  } catch {
    return DEFAULT_HYPERGATE_PORT;
  }
}

/**
 * The bearer token this Nekko Agent install should use on the gateway.
 *
 * Asks Hypergate for an agent called "Nekko Agent", creating it on first connect.
 * A scoped agent token beats the master one for the same reason a login beats
 * a root password: Hypergate can then show Nekko Agent in its Agents list, scope
 * which servers it may reach, attribute tool calls to it, and revoke it on its
 * own. Daemons predating that endpoint fall back to the gateway token, so an
 * older Hypergate still connects in one click.
 */
async function hypergateToken(base: string): Promise<{ token?: string; agent?: string }> {
  const signal = AbortSignal.timeout(2500);
  try {
    const res = await fetch(`${base}/api/clients/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'nekko-agent', create: true }),
      signal,
    });
    if (res.ok) {
      const agent = (await res.json()) as { token?: string; name?: string };
      if (agent?.token) return { token: agent.token, agent: agent.name };
    }
  } catch {
    /* older daemon, or it declined; the gateway token below still works */
  }
  try {
    const gw = (await (await fetch(`${base}/api/gateway`, { signal })).json()) as { token?: string };
    return { token: gw?.token };
  } catch {
    return {};
  }
}

/**
 * Everything the connect button (and the `nekko-agent://` deep link) needs: probe
 * the daemon, then get this install its own credential on it.
 *
 * Returns null when nothing is listening, so both callers can say "Hypergate
 * isn't running" rather than reporting a failure that isn't one.
 */
export async function resolveHypergate(port?: number): Promise<HypergateInfo | null> {
  const found = await detectHypergate(port);
  if (!found) return null;
  const { token, agent } = await hypergateToken(hypergateBase(port));
  return { ...found, token, agent };
}

/**
 * The MCP entry for a resolved gateway: one HTTP server whose tools are every
 * tool Hypergate manages, enabled so connecting actually connects something.
 */
export const hypergateEntry = (info: HypergateInfo): McpServerConfig => ({
  id: HYPERGATE_ENTRY_ID,
  name: 'Hypergate',
  command: '',
  args: [],
  url: info.url,
  token: info.token,
  enabled: true,
});

/**
 * Put the gateway into a server list: replace the existing entry if there is
 * one (a re-connect after a token rotation is the common case), and otherwise
 * append.
 */
export function withHypergate(servers: McpServerConfig[], info: HypergateInfo): McpServerConfig[] {
  const entry = hypergateEntry(info);
  const existing = servers.find((s) => s.id === HYPERGATE_ENTRY_ID);
  // Keep the user's own edits to the row (they may have renamed it) and only
  // overwrite what the daemon is authoritative about.
  return existing
    ? servers.map((s) => (s.id === HYPERGATE_ENTRY_ID ? { ...s, ...entry, name: s.name || entry.name } : s))
    : [...servers, entry];
}

/** Connection status for the UI. */
export function mcpStatus(configs: McpServerConfig[]): McpServerStatus[] {
  return configs.map((c) => {
    const srv = remote ? remote.servers[c.id] : servers.get(c.id);
    return {
      id: c.id,
      name: c.name,
      connected: !!srv?.connected,
      tools: (srv?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
      error: srv?.error,
    };
  });
}

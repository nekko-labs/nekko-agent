import { assertHostExecution } from './indirect-execution-guard.js';
import * as nodePty from '@lydell/node-pty';
import { existsSync } from 'fs';
import type { TerminalInfo, TerminalEvent, TerminalSnapshot, ShellOption } from '@nekko-agent/shared';
import { getSettings } from './store.js';
import { getSession } from './sessions.js';
import { appendAgentLog, readAgentLog } from './agent-log.js';

/**
 * Terminal sessions are real pseudo-terminals (PTYs), one shell per terminal.
 * Because there's a genuine TTY behind them, everything a native terminal does
 * works: tab-completion, powerline prompts, zsh plugins, and full-screen TUIs
 * (vim, htop, lazygit). The host streams raw bytes both ways and retains a
 * rolling scrollback buffer so a reattaching renderer can restore the screen.
 *
 * Backed by @lydell/node-pty: an N-API, prebuilt PTY whose binary loads under
 * both Node (server/cloud editions) and Electron (desktop) with no native
 * toolchain or electron-rebuild, which is why we can use it without breaking
 * the project's "builds everywhere" footprint. Terminals live in memory only.
 */

type Sender = (e: TerminalEvent) => void;

/** Rolling raw scrollback retained per terminal (bytes, for reattach). */
const MAX_BUFFER = 256_000;

interface TermState {
  info: TerminalInfo;
  proc: nodePty.IPty;
  /** Raw output retained verbatim (escape sequences included) for snapshots. */
  buffer: string;
  cols: number;
  rows: number;
}

const terms = new Map<string, TermState>();
let senders: Sender[] = [];

/**
 * The engine daemon, when this host runs as the desktop app's TS backend.
 *
 * Under `nekkod` the daemon owns every real pty (in Rust, see
 * `crates/nekko-term`), and this module keeps only the agent command logs,
 * which are virtual. Every other call is forwarded to the daemon, so the relay
 * and the CLI, which reach terminals through this host, see the same
 * terminals the UI does. Unset in the web and server editions, where this
 * module still owns the ptys itself.
 */
interface DaemonLink {
  url: string;
  token: string;
}
let daemon: DaemonLink | null = null;

const isAgentLog = (id: string) => id.startsWith('agent_');

async function daemonCall<T>(channel: string, ...args: unknown[]): Promise<T> {
  const link = daemon!;
  const res = await fetch(`${link.url}/api/${channel}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${link.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error ?? `${channel}: HTTP ${res.status}`);
  return body as T;
}

/**
 * Hand the ptys to the engine daemon and mirror its terminal events onto this
 * host's bus (the relay forwards that bus to paired phones). Only terminal
 * events are requested, so the host does not receive its own events back.
 */
export function useTerminalDaemon(link: DaemonLink | null): void {
  daemon = link;
  if (!link) return;
  // The mirror only feeds this host's phone relay. A daemon that runs remote
  // access itself (crates/nekko-remote) relays its terminals from its own hub,
  // and nothing else here reads them, so the output is not sent here at all.
  if ((process.env.NEKKOD_OWNS ?? '').split(',').includes('remote')) return;
  const connect = () => {
    if (daemon !== link) return;
    const ws = new WebSocket(`${link.url.replace(/^http/, 'ws')}/api/events?only=terminal:event&token=${encodeURIComponent(link.token)}`);
    ws.onmessage = (ev) => {
      try {
        const { channel, payload } = JSON.parse(String(ev.data));
        if (channel === 'terminal:event' && !isAgentLog(payload?.terminalId ?? '')) emit(payload as TerminalEvent);
      } catch {
        /* not a frame we understand */
      }
    };
    // An error is always followed by close, which reconnects. Closing from the
    // error handler instead re-fires the error on a socket still connecting
    // (Node's WebSocket), recursing until the stack overflows.
    ws.onclose = () => setTimeout(connect, 500);
  };
  connect();
}

/** Register the host event sink that fans terminal output out to renderers. */
export function setTerminalSender(send: Sender): void {
  if (!senders.includes(send)) senders.push(send);
}
const emit: Sender = (e) => senders.forEach((s) => s(e));

/** Detect shells installed on this machine, best first. */
function detectShells(): ShellOption[] {
  const out: ShellOption[] = [];
  const add = (id: string, label: string, paths: string[], args?: string[]) => {
    if (out.some((o) => o.id === id)) return;
    const hit = paths.find((p) => p && existsSync(p));
    if (hit) out.push({ id, label, path: hit, args });
  };
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const sys = process.env.SystemRoot ?? 'C:\\Windows';
    add('pwsh', 'PowerShell 7', [`${pf}\\PowerShell\\7\\pwsh.exe`]);
    add('powershell', 'Windows PowerShell', [`${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`]);
    add('cmd', 'Command Prompt', [`${sys}\\System32\\cmd.exe`]);
    add('gitbash', 'Git Bash', [`${pf}\\Git\\bin\\bash.exe`], ['--login', '-i']);
  } else {
    const env = process.env.SHELL;
    if (env && existsSync(env)) add('login', 'Login shell', [env], ['-l']);
    add('zsh', 'zsh', ['/bin/zsh', '/usr/bin/zsh']);
    add('bash', 'bash', ['/bin/bash', '/usr/bin/bash']);
    add('fish', 'fish', ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish']);
  }
  return out;
}

export function listShells(): ShellOption[] {
  return detectShells();
}

/** The shell a new terminal launches absent an explicit choice. */
function resolveShell(explicit?: string): ShellOption {
  const shells = detectShells();
  const wanted = explicit ?? getSettings().defaultShellPath;
  const found = wanted ? shells.find((s) => s.path === wanted) : undefined;
  if (found) return found;
  if (wanted && existsSync(wanted)) return { id: 'custom', label: 'Shell', path: wanted };
  if (shells[0]) return shells[0];
  // Absolute fallback if detection found nothing.
  return process.platform === 'win32'
    ? { id: 'cmd', label: 'Command Prompt', path: 'cmd.exe' }
    : { id: 'sh', label: 'sh', path: '/bin/sh' };
}

function resolveCwd(workspaceId?: string, cwd?: string, sessionId?: string): string {
  if (cwd && existsSync(cwd)) return cwd;
  // A chat's terminals belong in the chat's own checkout, not the shared project.
  if (sessionId) {
    const session = getSession(sessionId);
    const worktrees = session?.gitIsolation === false ? {} : session?.gitWorktrees ?? {};
    const path = (workspaceId ? worktrees[workspaceId] : undefined)?.path ?? Object.values(worktrees)[0]?.path;
    if (path && existsSync(path)) return path;
  }
  if (workspaceId) {
    const w = getSettings().workspaces.find((x) => x.id === workspaceId);
    if (w && existsSync(w.path)) return w.path;
  }
  const first = getSettings().workspaces[0]?.path;
  return first && existsSync(first) ? first : process.cwd();
}

export function finishAgentTerminal(sessionId: string): void {
  const state = terms.get(`agent_${sessionId}`);
  if (!state || !state.info.running) return;
  state.info.running = false;
  state.info.exitCode = 0;
  emit({ type: 'exit', terminalId: state.info.id, code: 0 });
}

export function appendAgentTerminal(sessionId: string, workspaceId: string | undefined, data: string): string {
  const id = `agent_${sessionId}`;
  let state = terms.get(id);
  if (!state) {
    const info: TerminalInfo = {
      id, title: 'Agent commands', workspaceId, cwd: resolveCwd(workspaceId, undefined, sessionId),
      shell: 'agent', agentSessionId: sessionId, createdAt: Date.now(), running: true,
    };
    state = { info, proc: null as unknown as nodePty.IPty, buffer: '', cols: 80, rows: 24 };
    terms.set(id, state);
  }
  state.info.running = true;
  delete state.info.exitCode;
  state.buffer = (state.buffer + data).slice(-MAX_BUFFER);
  emit({ type: 'data', terminalId: id, data });
  appendAgentLog(sessionId, data);
  return id;
}

/** Only this host's own terminals (under the daemon, the agent command logs). */
export function listAgentTerminals(): TerminalInfo[] {
  return sortTerminals([...terms.values()].map((t) => t.info));
}

export async function listTerminals(): Promise<TerminalInfo[]> {
  const local = [...terms.values()].map((t) => t.info);
  if (!daemon) return sortTerminals(local);
  const native = await daemonCall<TerminalInfo[]>('terminals:list:native').catch(() => []);
  return sortTerminals([...local, ...native]);
}

function sortTerminals(list: TerminalInfo[]): TerminalInfo[] {
  return list.sort((a, b) => {
    // Manually-ordered terminals first (in order), then the rest by age.
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return a.createdAt - b.createdAt;
  });
}

/** Update a terminal's grouping/order (used by sidebar drag-and-drop). */
export async function updateTerminal(id: string, patch: { workspaceId?: string | null; order?: number; title?: string }): Promise<void> {
  if (daemon && !isAgentLog(id)) return daemonCall('terminal:update', id, patch);
  const t = terms.get(id);
  if (!t) return;
  if ('workspaceId' in patch) t.info.workspaceId = patch.workspaceId ?? undefined;
  if (patch.order !== undefined) t.info.order = patch.order;
  if (patch.title) t.info.title = patch.title;
}

export async function terminalSnapshot(id: string): Promise<TerminalSnapshot | null> {
  if (daemon && !isAgentLog(id)) return daemonCall('terminal:snapshot', id);
  const t = terms.get(id);
  if (isAgentLog(id)) {
    const sessionId = id.slice('agent_'.length);
    const persisted = await readAgentLog(sessionId, MAX_BUFFER);
    if (t) return { info: t.info, buffer: persisted ?? t.buffer, cols: t.cols, rows: t.rows };
    if (persisted !== null) return {
      info: { id, title: 'Agent commands', shell: 'agent', agentSessionId: sessionId, cwd: '', createdAt: getSession(sessionId)?.createdAt ?? 0, running: false },
      buffer: persisted, cols: 80, rows: 24,
    };
  }
  return t ? { info: t.info, buffer: t.buffer, cols: t.cols, rows: t.rows } : null;
}

export async function createTerminal(opts?: { workspaceId?: string; sessionId?: string; cwd?: string; title?: string; shell?: string; cols?: number; rows?: number }): Promise<TerminalInfo> {
  assertHostExecution(opts?.sessionId, 'Host terminal');
  if (daemon) {
    // The daemon has no chat records, so hand it the resolved folder.
    const { sessionId, ...rest } = opts ?? {};
    return daemonCall('terminal:create', sessionId ? { ...rest, cwd: resolveCwd(rest.workspaceId, rest.cwd, sessionId) } : rest);
  }
  const id = `term_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const cwd = resolveCwd(opts?.workspaceId, opts?.cwd, opts?.sessionId);
  const shell = resolveShell(opts?.shell);
  const cols = opts?.cols ?? 80;
  const rows = opts?.rows ?? 24;

  const info: TerminalInfo = {
    id,
    title: opts?.title || shell.label || 'Terminal',
    workspaceId: opts?.workspaceId,
    cwd,
    shell: shell.path,
    createdAt: Date.now(),
    running: true,
  };

  let proc: nodePty.IPty;
  try {
    proc = nodePty.spawn(shell.path, shell.args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // A real TTY, leave TERM/PAGER alone so prompts and pagers render normally.
      env: { ...process.env } as Record<string, string>,
    });
  } catch (err) {
    info.running = false;
    info.exitCode = -1;
    const state: TermState = { info, proc: null as unknown as nodePty.IPty, buffer: `Failed to start ${shell.path}: ${String(err)}\r\n`, cols, rows };
    terms.set(id, state);
    queueMicrotask(() => emit({ type: 'exit', terminalId: id, code: -1 }));
    return info;
  }

  const state: TermState = { info, proc, buffer: '', cols, rows };
  terms.set(id, state);

  proc.onData((data: string) => {
    state.buffer = (state.buffer + data).slice(-MAX_BUFFER);
    emit({ type: 'data', terminalId: id, data });
  });
  proc.onExit(({ exitCode }) => {
    info.running = false;
    info.exitCode = exitCode;
    emit({ type: 'exit', terminalId: id, code: exitCode });
  });

  return info;
}

/** Write raw input (keystrokes) to the PTY. */
export function writeTerminal(id: string, data: string): void {
  if (daemon && !isAgentLog(id)) {
    void daemonCall('terminal:write', id, data).catch(() => {});
    return;
  }
  const t = terms.get(id);
  if (t && t.info.running && !t.info.agentSessionId) t.proc.write(data);
}

/** Resize the PTY so the shell reflows to the renderer's viewport. */
export function resizeTerminal(id: string, cols: number, rows: number): void {
  if (daemon && !isAgentLog(id)) {
    void daemonCall('terminal:resize', id, cols, rows).catch(() => {});
    return;
  }
  const t = terms.get(id);
  if (!t || !t.info.running || t.info.agentSessionId) return;
  t.cols = cols;
  t.rows = rows;
  try {
    t.proc.resize(Math.max(1, cols), Math.max(1, rows));
  } catch {
    /* pty gone */
  }
}

/** Convenience: type a command line and press Enter. */
export function runInTerminal(id: string, command: string): void {
  writeTerminal(id, command + '\r');
}

export function signalTerminal(id: string, _signal: 'interrupt'): void {
  // Real PTY: Ctrl-C is just ETX on the input stream; the tty delivers SIGINT.
  writeTerminal(id, '\x03');
}

export function closeTerminal(id: string): void {
  if (daemon && !isAgentLog(id)) {
    void daemonCall('terminal:close', id).catch(() => {});
    return;
  }
  const t = terms.get(id);
  if (!t) return;
  try {
    t.proc?.kill();
  } catch {
    /* already gone */
  }
  terms.delete(id);
}

/** Kill every shell (called on host teardown). */
export function closeAllTerminals(): void {
  for (const id of [...terms.keys()]) closeTerminal(id);
}

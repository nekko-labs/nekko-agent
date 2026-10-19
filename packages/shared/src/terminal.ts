/**
 * Terminal session types, a real PTY (pseudo-terminal) per session.
 *
 * Each terminal is a live shell attached to a pseudo-terminal, so it behaves
 * like a native terminal: tab-completion, powerline prompts, zsh plugins, and
 * full-screen TUIs (vim, htop, lazygit) all work. The renderer is xterm.js; the
 * engine daemon streams raw bytes both ways (crates/nekko-term, on
 * portable-pty: ConPTY on Windows, a Unix pty elsewhere).
 */

/** A live shell session attached to a PTY. */
export interface TerminalInfo {
  id: string;
  title: string;
  /** Project this terminal belongs to (groups it in the workbench sidebar). */
  workspaceId?: string;
  /** Working directory the shell started in. */
  cwd: string;
  /** Shell binary the PTY is running (e.g. powershell.exe, /bin/zsh). */
  shell: string;
  agentSessionId?: string;
  createdAt: number;
  /** Manual sidebar position within its project (set by drag-to-reorder). */
  order?: number;
  /** False once the shell process has exited. */
  running: boolean;
  exitCode?: number;
}

/** A shell the host detected as available to launch. */
export interface ShellOption {
  /** Stable id (e.g. 'pwsh', 'bash', 'zsh'). */
  id: string;
  /** Human label shown in the picker (e.g. 'PowerShell', 'zsh'). */
  label: string;
  /** Absolute path to the shell binary. */
  path: string;
  /** Extra launch args (e.g. login flags). */
  args?: string[];
}

/**
 * Snapshot returned when a renderer (re)attaches to a terminal. `buffer` is the
 * raw retained output (escape sequences included) which xterm.js replays
 * verbatim to restore scrollback.
 */
export interface TerminalSnapshot {
  info: TerminalInfo;
  buffer: string;
  cols: number;
  rows: number;
}

/** Streaming events emitted by a terminal, mirrored to every renderer. */
export type TerminalEvent =
  | { type: 'data'; terminalId: string; data: string }
  | { type: 'exit'; terminalId: string; code: number | null };

/** What a terminal stream calls back with (see `NekkoApi.openTerminalStream`). */
export interface TerminalStreamHandlers {
  /** First frame: the pty's size and whether the shell still runs; `replay` bytes of scrollback follow. */
  onHello?(hello: { cols: number; rows: number; running: boolean; replay: number; info?: TerminalInfo }): void;
  /** Raw output bytes (escape sequences included). Acknowledge them once parsed. */
  onData(bytes: Uint8Array): void;
  onExit?(code: number | null): void;
  /** The stream dropped (the engine restarted); reopen to resume from the scrollback. */
  onClose?(): void;
}

/** A live terminal stream. */
export interface TerminalStream {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Tell the engine this many output bytes were parsed, so it can send more. */
  ack(bytes: number): void;
  close(): void;
}

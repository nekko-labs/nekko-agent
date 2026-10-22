/**
 * Terminals and SSH from a paired phone (IO-33 FA-3, FA-6): which channels
 * open, the rules for their arguments, what the phone receives, and the
 * limits of the live stream. `phone-access.ts` wires these into the policy;
 * the daemon's gate (crates/nekko-remote/src/phone_terminal.rs) reads the
 * same numbers from `phone-access.json` and the parity fixture
 * `crates/nekko-remote/tests/golden/phone-terminal.json`, which
 * phone-terminal.golden.test.ts writes from this file (UPDATE_GOLDEN=1).
 *
 * The rules (SPEC "Terminals and SSH on the phone"):
 * - Read: `terminals:list` (one chat's, a `sessionId` is required),
 *   `terminal:tail` (capped at `tailBytes`) and `ssh:hosts`.
 * - Change, a signed proof each (Face ID within 5 minutes): `terminal:create`,
 *   `ssh:open`, `terminal:signal`, `terminal:close`, and the gate's own
 *   `terminal:open` (attach to an existing terminal).
 * - Typing: `terminal:write` and `terminal:resize` carry the terminal session
 *   token that opening it (`terminal:open`, `terminal:create`, `ssh:open`)
 *   handed out, as their last argument, instead of a proof per keystroke. The
 *   token is bound to the phone and the terminal, ends when the phone leaves,
 *   disconnects or is revoked, when the terminal exits, after `tokenIdleMs`
 *   without input and after `tokenMaxMs` whatever happens; the phone's Change
 *   switch is checked on every write. Only the Rust gate holds tokens.
 * - Output: `terminal:event` reaches only the phones attached to that
 *   terminal, at most `eventBytes` per `eventWindowMs` per terminal; beyond
 *   `eventBacklogBytes` waiting, the backlog is dropped and the next event
 *   says how much (`skipped`) so the phone reads the tail again.
 * - A phone reaches only terminals opened for a chat (`sessionId`) and the
 *   agent's command logs (read only); never the desktop's other terminals.
 */

/** Limits of terminals on a phone. */
export const PHONE_TERMINAL = {
  /** The most scroll-back a phone receives (`terminal:tail`, and on opening). */
  tailBytes: 64 * 1024,
  /** The most one `terminal:write` may carry (UTF-8 bytes); a longer paste is sent in parts. */
  writeBytes: 64 * 1024,
  titleChars: 120,
  /** `ssh:hosts`: the first this many hosts, each field cut to `hostChars`. */
  hosts: 200,
  hostChars: 255,
  /** `terminal:create`, `ssh:open` and `terminal:resize` sizes: 1 to these. */
  maxCols: 500,
  maxRows: 300,
  /** A terminal session token ends this long after its last write or resize... */
  tokenIdleMs: 5 * 60 * 1000,
  /** ...and this long after it was handed out, whatever happens. */
  tokenMaxMs: 30 * 60 * 1000,
  /** Live output to a phone: at most `eventBytes` per `eventWindowMs` per terminal. */
  eventBytes: 32 * 1024,
  eventWindowMs: 100,
  /** Output waiting beyond this is dropped, and the phone told (`skipped`). */
  eventBacklogBytes: 256 * 1024,
} as const;

export const PHONE_TERMINAL_READ_CHANNELS = ['ssh:hosts', 'terminal:tail', 'terminals:list'] as const;
export const PHONE_TERMINAL_CHANGE_CHANNELS = ['ssh:open', 'terminal:close', 'terminal:create', 'terminal:signal'] as const;
/** Allowed with a terminal session token, not a proof per call. */
export const PHONE_TERMINAL_TOKEN_CHANNELS = ['terminal:resize', 'terminal:write'] as const;
/** Every terminal channel a phone may call. Other `terminal:` / `terminals:` channels stay denied. */
export const PHONE_TERMINAL_CHANNELS = [
  ...PHONE_TERMINAL_READ_CHANNELS,
  ...PHONE_TERMINAL_CHANGE_CHANNELS,
  ...PHONE_TERMINAL_TOKEN_CHANNELS,
].sort();

/**
 * Answered by the computer's gate itself, like `device:registerKey`:
 * `terminal:open [terminalId]` (change-class, a signed proof) attaches this
 * phone to a terminal and answers a `PhoneTerminalOpened`;
 * `terminal:leave [terminalId]` detaches it (no proof: it only gives up access).
 */
export const PHONE_TERMINAL_OPEN_CHANNEL = 'terminal:open';
export const PHONE_TERMINAL_LEAVE_CHANNEL = 'terminal:leave';

/** A terminal as a phone sees it: no absolute paths, no other viewers' names. */
export interface PhoneTerminal {
  id: string;
  title: string;
  /** `agent` for the agent's command log (read only), `ssh` for an SSH session. */
  kind: 'shell' | 'ssh' | 'agent';
  /** The name of the folder it started in (not its path). */
  folder: string;
  /** The shell's name (`zsh`, `pwsh`), not its path. */
  shell: string;
  running: boolean;
  exitCode?: number;
  createdAt?: number;
  sessionId?: string;
  /** How many remote viewers (phones) are attached. */
  viewers: number;
}

/** `terminal:tail`, and the scroll-back a phone gets on opening. */
export interface PhoneTerminalTail {
  terminal: PhoneTerminal | null;
  buffer: string;
  cols: number;
  rows: number;
  truncated: boolean;
  totalBytes?: number;
}

/** What `terminal:open`, `terminal:create` and `ssh:open` answer a phone. */
export interface PhoneTerminalOpened extends PhoneTerminalTail {
  /** For `terminal:write` / `terminal:resize` on this terminal, from this phone only. */
  token: string;
  idleMs: number;
  maxMs: number;
}

/** A host from the computer's `~/.ssh/config`: no user name, never keys. */
export interface PhoneSshHost {
  alias: string;
  hostName?: string;
  port?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** `s` cut to `n` UTF-16 units, never leaving half of a surrogate pair. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const end = s.charCodeAt(n - 1) >= 0xd800 && s.charCodeAt(n - 1) <= 0xdbff ? n - 1 : n;
  return s.slice(0, end);
}

/** The last part of a path, with `/` or `\` separators. */
export function phoneBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts.length ? parts[parts.length - 1] : '';
}

function shellName(path: string): string {
  const base = phoneBaseName(path);
  return base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base;
}

/** One terminal as a phone sees it, or `null` for anything that isn't one. */
export function phoneTerminalView(info: unknown): PhoneTerminal | null {
  if (!isObj(info) || typeof info.id !== 'string') return null;
  const shell = shellName(str(info.shell));
  const agent = str(info.agentSessionId) !== '' || shell === 'agent';
  const out: PhoneTerminal = {
    id: info.id,
    title: cut(str(info.title), PHONE_TERMINAL.titleChars),
    kind: agent ? 'agent' : shell.toLowerCase() === 'ssh' ? 'ssh' : 'shell',
    folder: phoneBaseName(str(info.cwd)),
    shell,
    running: info.running === true,
    viewers: Array.isArray(info.viewers) ? info.viewers.length : 0,
  };
  if (typeof info.exitCode === 'number') out.exitCode = info.exitCode;
  if (typeof info.createdAt === 'number') out.createdAt = info.createdAt;
  const sid = str(info.sessionId) || str(info.agentSessionId);
  if (sid) out.sessionId = sid;
  return out;
}

export function phoneTerminalsView(list: unknown): PhoneTerminal[] {
  if (!Array.isArray(list)) return [];
  return list.map(phoneTerminalView).filter((t): t is PhoneTerminal => t !== null);
}

/** A snapshot as a phone receives it: the buffer already capped by the computer. */
export function phoneTerminalTailView(snap: unknown): PhoneTerminalTail | null {
  if (!isObj(snap)) return null;
  const out: PhoneTerminalTail = {
    terminal: phoneTerminalView(snap.info),
    buffer: str(snap.buffer),
    cols: isInt(snap.cols) ? snap.cols : 80,
    rows: isInt(snap.rows) ? snap.rows : 24,
    truncated: snap.truncated === true,
  };
  if (isInt(snap.totalBytes)) out.totalBytes = snap.totalBytes;
  return out;
}

export function phoneSshHostsView(list: unknown): PhoneSshHost[] {
  if (!Array.isArray(list)) return [];
  const out: PhoneSshHost[] = [];
  for (const h of list) {
    if (out.length >= PHONE_TERMINAL.hosts) break;
    if (!isObj(h) || typeof h.alias !== 'string' || h.alias === '') continue;
    const host: PhoneSshHost = { alias: cut(h.alias, PHONE_TERMINAL.hostChars) };
    if (typeof h.hostName === 'string' && h.hostName !== '') host.hostName = cut(h.hostName, PHONE_TERMINAL.hostChars);
    if (isInt(h.port) && h.port >= 1 && h.port <= 65535) host.port = h.port;
    out.push(host);
  }
  return out;
}

/** UTF-8 length, as the gate counts a write. */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** A refusal: a `PhoneAccessCode` and its detail. */
export type PhoneTerminalProblem = [code: string, detail: string];

const SIZE_KEYS = ['cols', 'rows'];

function sizeProblem(o: Obj): PhoneTerminalProblem | null {
  if (o.cols !== undefined && !(isInt(o.cols) && o.cols >= 1 && o.cols <= PHONE_TERMINAL.maxCols)) return ['value-invalid', 'cols'];
  if (o.rows !== undefined && !(isInt(o.rows) && o.rows >= 1 && o.rows <= PHONE_TERMINAL.maxRows)) return ['value-invalid', 'rows'];
  return null;
}

function keysProblem(o: Obj, allowed: readonly string[]): PhoneTerminalProblem | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return ['option-denied', k];
  return null;
}

/**
 * What is wrong with a phone's terminal call's arguments, or `null`. Only
 * the channels in `PHONE_TERMINAL_CHANNELS`; the token itself is checked by
 * the gate, which alone holds them.
 */
export function phoneTerminalProblem(channel: string, args: unknown[]): PhoneTerminalProblem | null {
  const id = (i: number, what: string): PhoneTerminalProblem | null =>
    typeof args[i] === 'string' && args[i] !== '' ? null : ['value-invalid', what];
  const token = (i: number): PhoneTerminalProblem | null =>
    typeof args[i] === 'string' && args[i] !== '' ? null : ['token-required', channel];
  switch (channel) {
    case 'terminals:list': {
      const o = args[0];
      if (!isObj(o) || typeof o.sessionId !== 'string' || o.sessionId === '') return ['value-invalid', 'chat id'];
      return keysProblem(o, ['sessionId']);
    }
    case 'terminal:tail':
      if (args[1] !== undefined && args[1] !== null && !(isInt(args[1]) && args[1] >= 1)) return ['value-invalid', 'maxBytes'];
      return id(0, 'terminal id');
    case 'ssh:hosts':
      return null;
    case 'terminal:create': {
      const o = args[0];
      if (!isObj(o)) return ['value-invalid', 'terminal options'];
      const keys = keysProblem(o, [...SIZE_KEYS, 'sessionId', 'title']);
      if (keys) return keys;
      if (typeof o.sessionId !== 'string' || o.sessionId === '') return ['value-invalid', 'chat id'];
      if (o.title !== undefined && typeof o.title !== 'string') return ['value-invalid', 'title'];
      return sizeProblem(o);
    }
    case 'ssh:open': {
      if (typeof args[0] !== 'string' || args[0] === '' || args[0].length > PHONE_TERMINAL.hostChars) return ['value-invalid', 'host alias'];
      const o = args[1];
      if (!isObj(o)) return ['value-invalid', 'terminal options'];
      const keys = keysProblem(o, [...SIZE_KEYS, 'sessionId']);
      if (keys) return keys;
      if (typeof o.sessionId !== 'string' || o.sessionId === '') return ['value-invalid', 'chat id'];
      return sizeProblem(o);
    }
    case 'terminal:write':
      if (typeof args[1] !== 'string' || utf8Bytes(args[1]) > PHONE_TERMINAL.writeBytes) return ['value-invalid', 'input'];
      return id(0, 'terminal id') ?? token(2);
    case 'terminal:resize':
      return id(0, 'terminal id') ?? sizeProblem({ cols: args[1] ?? null, rows: args[2] ?? null }) ?? token(3);
    case 'terminal:signal':
    case 'terminal:close':
      return id(0, 'terminal id');
    default:
      return null;
  }
}

/**
 * The arguments the computer's own call gets for a checked terminal call:
 * only what it takes, the token dropped, the tail capped. `terminal:create`
 * also gets the chat's folder (`workspaceId`), which the caller looks up.
 */
export function phoneTerminalCallArgs(channel: string, args: unknown[]): unknown[] {
  const size = (o: Obj): Obj => {
    const out: Obj = {};
    if (isInt(o.cols)) out.cols = o.cols;
    if (isInt(o.rows)) out.rows = o.rows;
    return out;
  };
  switch (channel) {
    case 'terminals:list':
      return [{ sessionId: (args[0] as Obj).sessionId }];
    case 'terminal:tail':
      return [args[0], Math.min(isInt(args[1]) ? args[1] : PHONE_TERMINAL.tailBytes, PHONE_TERMINAL.tailBytes)];
    case 'ssh:hosts':
      return [];
    case 'terminal:create': {
      const o = args[0] as Obj;
      const out: Obj = { sessionId: o.sessionId, ...size(o) };
      if (typeof o.title === 'string' && o.title !== '') out.title = cut(o.title, PHONE_TERMINAL.titleChars);
      return [out];
    }
    case 'ssh:open':
      return [args[0], { sessionId: (args[1] as Obj).sessionId, ...size(args[1] as Obj) }];
    case 'terminal:write':
      return [args[0], args[1]];
    case 'terminal:resize':
      return [args[0], args[1], args[2]];
    case 'terminal:signal':
    case 'terminal:close':
      return [args[0]];
    default:
      return args;
  }
}

/** What a phone receives for a terminal channel's result. */
export function phoneTerminalResult(channel: string, result: unknown): unknown {
  switch (channel) {
    case 'terminals:list':
      return phoneTerminalsView(result);
    case 'terminal:tail':
      return phoneTerminalTailView(result);
    case 'ssh:hosts':
      return phoneSshHostsView(result);
    case 'terminal:create':
    case 'ssh:open':
      // The gate answers these with a `PhoneTerminalOpened` once it has attached the phone.
      return phoneTerminalView(result);
    default:
      return null;
  }
}

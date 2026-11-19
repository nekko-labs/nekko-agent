// The status line `npm run dev` keeps pinned to the bottom row of its terminal,
// under the logs: what the agents are doing (Building n, Verifying n, Idle),
// a stop in progress, or that the app has gone quiet. The app's main process
// writes a heartbeat once a second (reportDevStatus in devLaunchProcess.ts);
// the indicator moves only while those keep coming, so a frozen app shows as
// a still indicator and a warning rather than a cheerful spinner.

import { writeSync } from 'node:fs';

/** A heartbeat older than this means the app's main process has stopped answering. */
export const STALE_MS = 3000;
/** How often the line is drawn (and the indicator steps). */
export const TICK_MS = 120;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SNORE = ['z  ', 'zz ', 'zzz'];
// The banner's cat, awake while agents work and asleep while idle.
const CAT_AWAKE = '( o.o )';
const CAT_ASLEEP = '( -.- )';
const CAT_WORRIED = '( o.O )';

const plain = { dim: (s) => s, accent: (s) => s, ok: (s) => s, warn: (s) => s, bad: (s) => s, key: (s) => s };
const ansi = {
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  accent: (s) => `\x1b[38;5;141m${s}\x1b[39m`,
  ok: (s) => `\x1b[32m${s}\x1b[39m`,
  warn: (s) => `\x1b[33m${s}\x1b[39m`,
  bad: (s) => `\x1b[31m${s}\x1b[39m`,
  key: (s) => `\x1b[1m${s}\x1b[22m`,
};

const secs = (ms) => `${Math.max(0, Math.floor(ms / 1000))}s`;

/**
 * The status line for one moment, fitted to `columns`.
 * @param {{
 *   now: number,
 *   startedAt: number,
 *   frame: number,
 *   report?: { at: number, quitting?: boolean, activity?: { building: number, verifying: number, input?: number } | null, unresponsive?: number } | null,
 *   stoppingSince?: number | null,
 *   columns?: number,
 *   color?: boolean,
 * }} s
 */
export function statusLine(s) {
  const c = s.color ? ansi : plain;
  const columns = Math.max(20, s.columns ?? 80);
  const spin = SPINNER[s.frame % SPINNER.length];
  const report = s.report ?? null;
  const fresh = !!report && s.now - report.at < STALE_MS;
  /** @type {[string, (t: string) => string][]} */
  let main;
  let hint = [['q', ' stop · '], ['r', ' restart']];

  if (s.stoppingSince != null || (fresh && report.quitting)) {
    const since = s.stoppingSince ?? report.at;
    main = [[`${spin} `, c.warn], [`${CAT_AWAKE} `, c.accent], [`Stopping cleanly... ${secs(s.now - since)}`, (t) => t]];
    hint = s.stoppingSince != null ? [['q', ' again to force']] : [];
  } else if (!report) {
    main = [[`${spin} `, c.dim], [`${CAT_AWAKE} `, c.accent], [`Starting Nekko Agent... ${secs(s.now - s.startedAt)}`, (t) => t]];
  } else if (!fresh) {
    main = [['! ', c.bad], [`${CAT_WORRIED} `, c.accent], [`No word from the app for ${secs(s.now - report.at)}: it may be frozen`, c.bad]];
  } else if (!report.activity) {
    main = [[`${spin} `, c.warn], [`${CAT_AWAKE} `, c.accent], ['The engine is not answering', c.warn]];
  } else {
    const { building = 0, verifying = 0, input = 0 } = report.activity;
    const parts = [];
    if (building) parts.push(`Building ${building}`);
    if (verifying) parts.push(`Verifying ${verifying}`);
    if (input) parts.push(`${input} waiting on you`);
    main = parts.length
      ? [[`${spin} `, c.ok], [`${CAT_AWAKE} `, c.accent], [parts.join(' · '), (t) => t]]
      : [[`${SNORE[Math.floor(s.frame / 8) % SNORE.length]} `, c.dim], [`${CAT_ASLEEP} `, c.accent], ['Idle', c.dim]];
  }
  if (fresh && report.unresponsive) main.push([` · ${report.unresponsive === 1 ? 'a window is' : `${report.unresponsive} windows are`} not responding`, c.warn]);

  const width = (segs) => segs.reduce((n, [t]) => n + [...t].length, 0);
  const hintSegs = hint.flatMap(([k, rest]) => [[k, c.key], [rest, c.dim]]);
  const gap = columns - 1 - width(main) - width(hintSegs);
  const segs = gap >= 2 ? [...main, [' '.repeat(gap), (t) => t], ...hintSegs] : main;
  // Cut to the width, a character at a time, colouring what is left.
  let room = columns - 1;
  let out = ' ';
  for (const [text, paint] of segs) {
    if (room <= 0) break;
    const chars = [...text];
    const kept = chars.slice(0, room).join('');
    room -= Math.min(chars.length, room);
    out += paint(kept);
  }
  return out;
}

/**
 * Keep one line pinned to the terminal's bottom row: a scroll region over the
 * rows above it holds the logs, so electron-vite's and the app's output (which
 * write to the same terminal directly) scroll there and never cover it. Writes
 * are synchronous so the terminal is put back even on the way out of `exit`.
 * @param {{ fd: number, rows?: number, columns?: number, on(e: 'resize', f: () => void): unknown, off(e: 'resize', f: () => void): unknown }} out
 */
export function pinnedLine(out) {
  const write = (s) => { try { writeSync(out.fd, s); } catch { /* the terminal went away */ } };
  let rows = 0;
  let last = '';
  const region = () => {
    rows = out.rows ?? 0;
    // DECSTBM homes the cursor: save and restore around it.
    if (rows >= 5) write(`\x1b7\x1b[1;${rows - 1}r\x1b8`);
  };
  const onResize = () => { region(); draw(last); };
  const draw = (line) => {
    last = line;
    if (rows >= 5) write(`\x1b7\x1b[${rows};1H\x1b[2K${line}\x1b8`);
  };
  // Make room first, so a cursor on the bottom row ends up inside the region.
  write('\n\x1b[1A');
  region();
  out.on('resize', onResize);
  let open = true;
  return {
    draw,
    /** Give the whole terminal back to the logs and clear the line. */
    close() {
      if (!open) return;
      open = false;
      out.off('resize', onResize);
      if (rows >= 5) write(`\x1b7\x1b[r\x1b[${rows};1H\x1b[2K\x1b8`);
    },
  };
}

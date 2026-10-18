/**
 * What a paired phone sees of the files the agent changed in a chat: a
 * read-only, capped diff computed on the computer (`changes:list` through
 * `phoneChangesView`). Only when the computer allows it (`phoneChanges` in
 * settings, off unless set); accepting or reverting changes, reading other
 * files and terminals stay refused (`PHONE_ALWAYS_DENIED`).
 *
 * The daemon has the same projection (crates/nekko-remote/src/phone_changes.rs),
 * held to this one by the phone golden (tests/golden/phone.json).
 */

/** The limits of a phone's Changes view. */
export const PHONE_CHANGES_VIEW = {
  /** Files listed; the rest are counted in `omittedFiles`. */
  files: 50,
  /** Diff lines shown per file; past this the file says how many there are. */
  linesPerFile: 400,
  /** UTF-8 bytes of diff lines per file. */
  bytesPerFile: 64 * 1024,
  /** UTF-8 bytes of diff lines across all files. */
  totalBytes: 512 * 1024,
  /** Unchanged lines kept around each change. */
  context: 3,
  /** Above this many comparison cells a file's changed region is shown as removed then added. */
  diffCells: 4_000_000,
} as const;

/** One hunk of a unified diff; each line starts with ' ', '-' or '+'. */
export interface PhoneHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

/** One changed file as a phone sees it. */
export interface PhoneFileChange {
  /** The last two path segments (`…/src/app.ts`): never the full path on the computer. */
  path: string;
  status: 'added' | 'modified';
  added: number;
  removed: number;
  hunks: PhoneHunk[];
  /** A file that may hold secrets: counted, never shown. */
  hidden?: true;
  /** Not text. */
  binary?: true;
  /** Over a limit: `lines` says how many diff lines there are. */
  tooLarge?: true;
  lines?: number;
}

export interface PhoneChanges {
  files: PhoneFileChange[];
  omittedFiles?: number;
}

/** Files whose content never goes to a phone, by name or folder. */
export function phoneSecretFile(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase();
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (/(^|\/)\.(ssh|aws|gnupg)\//.test(p)) return true;
  if (name.startsWith('.env') || name.startsWith('id_')) return true;
  if (['.npmrc', '.netrc', '.pypirc', 'credentials'].includes(name)) return true;
  return ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'].some((ext) => name.endsWith(ext));
}

/** The last two path segments, `…/` first when there were more. */
export function phoneDisplayPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  if (parts.length <= 2) return parts.join('/');
  return `…/${parts.slice(-2).join('/')}`;
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  const out = s.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;

type Op = { t: ' ' | '-' | '+'; line: string };

/**
 * Line edits from `a` to `b`: the common start and end are kept, the middle
 * compared by longest common subsequence (removals before additions on ties),
 * or shown as removed then added when it is too big to compare.
 */
export function lineOps(a: string[], b: string[], cells: number = PHONE_CHANGES_VIEW.diffCells): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  const ops: Op[] = a.slice(0, pre).map((line) => ({ t: ' ', line }));
  const n = ma.length;
  const m = mb.length;
  if (n * m > cells) {
    for (const line of ma) ops.push({ t: '-', line });
    for (const line of mb) ops.push({ t: '+', line });
  } else {
    // lcs[i * (m + 1) + j]: longest common subsequence of ma[i..] and mb[j..].
    const w = m + 1;
    const lcs = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        ops.push({ t: ' ', line: ma[i] });
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        ops.push({ t: '-', line: ma[i] });
        i++;
      } else {
        ops.push({ t: '+', line: mb[j] });
        j++;
      }
    }
  }
  for (const line of a.slice(a.length - suf)) ops.push({ t: ' ', line });
  return ops;
}

/** Unified-diff hunks with `context` unchanged lines around each change. */
export function hunksOf(ops: Op[], context: number = PHONE_CHANGES_VIEW.context): PhoneHunk[] {
  const changed: number[] = [];
  ops.forEach((o, k) => {
    if (o.t !== ' ') changed.push(k);
  });
  if (!changed.length) return [];
  // Ranges of op indexes, merged when their context would touch.
  const ranges: Array<[number, number]> = [];
  for (const k of changed) {
    const start = Math.max(0, k - context);
    const end = Math.min(ops.length - 1, k + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  // Line numbers before each op.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let nw = 1;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(nw);
    if (op.t !== '+') o++;
    if (op.t !== '-') nw++;
  }
  return ranges.map(([s, e]) => ({
    oldStart: oldAt[s],
    newStart: newAt[s],
    lines: ops.slice(s, e + 1).map((op) => op.t + op.line),
  }));
}

type Change = { path?: unknown; original?: unknown; current?: unknown };

/** The changes of one chat as a phone receives them (see `PHONE_CHANGES_VIEW`). */
export function phoneChangesView(changes: unknown): PhoneChanges {
  const view = PHONE_CHANGES_VIEW;
  const list = (Array.isArray(changes) ? changes : []).filter(
    (c): c is Change => typeof c === 'object' && c !== null && typeof (c as Change).path === 'string',
  );
  const files: PhoneFileChange[] = [];
  let total = 0;
  let omitted = 0;
  for (const c of list) {
    const original = typeof c.original === 'string' ? c.original : '';
    const current = typeof c.current === 'string' ? c.current : '';
    if (original === current) continue;
    if (files.length >= view.files) {
      omitted++;
      continue;
    }
    const path = c.path as string;
    const ops = lineOps(splitLines(original), splitLines(current));
    const added = ops.filter((op) => op.t === '+').length;
    const removed = ops.filter((op) => op.t === '-').length;
    const file: PhoneFileChange = { path: phoneDisplayPath(path), status: original === '' ? 'added' : 'modified', added, removed, hunks: [] };
    if (phoneSecretFile(path)) {
      file.hidden = true;
    } else if (original.includes('\u0000') || current.includes('\u0000')) {
      file.binary = true;
    } else {
      const hunks = hunksOf(ops);
      const lines = hunks.reduce((n, h) => n + h.lines.length, 0);
      const bytes = hunks.reduce((n, h) => n + h.lines.reduce((b, l) => b + utf8(l), 0), 0);
      if (lines > view.linesPerFile || bytes > view.bytesPerFile || total + bytes > view.totalBytes) {
        file.tooLarge = true;
        file.lines = lines;
      } else {
        file.hunks = hunks;
        total += bytes;
      }
    }
    files.push(file);
  }
  return omitted ? { files, omittedFiles: omitted } : { files };
}

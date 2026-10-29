/**
 * What a run of tool calls is for, so the chat can fold adjacent calls with one
 * purpose into a single row that says the goal ("Read the project's guidance",
 * "Edited 3 files", "Ran the tests") instead of listing every call.
 *
 * Pure and deterministic: no model call, no added latency, nothing sent
 * anywhere. The call's own `description` (Claude Code's Bash and Task send one)
 * is preferred as the goal; otherwise the purpose comes from the tool name and
 * input. Ported to Swift (`ToolPurpose.swift` in NekkoProtocol) and Kotlin
 * (`ToolPurpose.kt` in the Android protocol module); all three run the cases in
 * `packages/shared/fixtures/tool-purpose.json`, so change them together.
 *
 * Spec: spec/chat/tool-calls-grouped-by-purpose.md.
 */

export type ToolPurpose = 'guidance' | 'explore' | 'edit' | 'check' | 'run' | 'git' | 'web' | 'plan' | 'delegate' | 'other';

/** A call as grouping sees it: its name and input, and whether it failed. */
export interface PurposeCall {
  name: string;
  input?: unknown;
  failed?: boolean;
}

/** Tool names compared without case, `_`, `-` or spaces: `read_file`, `Read` and `ReadFile` alike. */
function key(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, '');
}

const READ = new Set(['readfile', 'read', 'view', 'openfile', 'notebookread', 'readmanyfiles', 'cat']);
const LIST = new Set(['listdir', 'ls', 'listdirectory', 'listfiles']);
const SEARCH = new Set(['grep', 'glob', 'search', 'find', 'findfiles', 'filesearch', 'codebasesearch', 'grepsearch', 'searchfiles']);
const EDIT = new Set([
  'writefile', 'editfile', 'write', 'edit', 'multiedit', 'applypatch', 'notebookedit', 'createfile',
  'strreplace', 'strreplaceeditor', 'strreplacebasededittool', 'deletefile', 'patch',
]);
const SHELL = new Set([
  'bash', 'shell', 'runcommand', 'runterminalcmd', 'exec', 'execcommand', 'powershell', 'terminal',
  'localshell', 'runshellcommand', 'startprocess', 'readprocess', 'killprocess', 'bashoutput', 'killshell', 'killbash',
]);
const WEB_SEARCH = new Set(['websearch', 'searchweb', 'googlesearch']);
const WEB = new Set([...WEB_SEARCH, 'webfetch', 'fetchurl', 'fetch', 'browser', 'browse']);
const PLAN = new Set(['updateplan', 'todowrite', 'todoread', 'writetodos', 'exitplanmode', 'enterplanmode', 'decide']);
const DELEGATE = new Set(['spawnagent', 'task', 'agent', 'subagent', 'dispatchagent', 'delegationtargets']);
const ASK = new Set(['askuser', 'askuserquestion', 'askfollowupquestion']);

function isMcp(name: string): boolean {
  return name.startsWith('mcp__');
}

/** A question for the person: never folded into a group, because it needs them. */
export function needsUser(call: { name: string }): boolean {
  return ASK.has(key(call.name));
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function inputOf(call: { input?: unknown }): Record<string, unknown> {
  const i = call.input;
  return i && typeof i === 'object' && !Array.isArray(i) ? (i as Record<string, unknown>) : {};
}

const PATH_KEYS = ['file_path', 'path', 'file', 'filename', 'target_file', 'notebook_path', 'absolute_path', 'relative_workspace_path', 'dir', 'directory'];

/** The paths a file tool names: its path arguments, else a glob's pattern. */
function pathsOf(call: PurposeCall): string[] {
  const input = inputOf(call);
  const out: string[] = [];
  for (const k of PATH_KEYS) {
    const v = str(input[k]);
    if (v) out.push(v);
  }
  if (Array.isArray(input.paths)) for (const p of input.paths) if (str(p)) out.push(String(p).trim());
  if (!out.length && key(call.name) === 'glob') {
    const p = str(input.pattern);
    if (p) out.push(p);
  }
  return out;
}

/** The last segment of a path, either separator. */
export function pathLeaf(path: string): string {
  const segs = path.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

const GUIDE_FILES = new Set(['agents.md', 'claude.md', 'claude.local.md', 'gemini.md', 'skill.md', '.cursorrules', '.windsurfrules', 'copilot-instructions.md']);

/**
 * A file or folder that tells an agent how to work in the project: the agent
 * instruction files, READMEs and contributing guides, and the runbooks,
 * decisions and spec folders (their Markdown, or the folder itself).
 */
export function isGuidancePath(path: string): boolean {
  const segs = path.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const base = segs[segs.length - 1] ?? '';
  if (GUIDE_FILES.has(base) || /^(?:readme|contributing)(?:\.|$)/.test(base)) return true;
  const markdownOrFolder = base.endsWith('.md') || base.endsWith('.mdx') || !base.includes('.');
  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1];
    if (segs[i] === 'docs' && (next === 'runbooks' || next === 'decisions') && markdownOrFolder) return true;
    if (segs[i] === 'spec' && markdownOrFolder) return true;
    if (segs[i] === '.cursor' && next === 'rules') return true;
    // `.claude/worktrees/` holds whole checkouts, not instructions.
    if (segs[i] === '.claude' && next !== 'worktrees') return true;
    if (segs[i] === '.github' && base.endsWith('.md')) return true;
  }
  return false;
}

/** The command a shell tool ran, as one string. Codex-style `["bash", "-lc", "…"]` arrays keep the script. */
export function shellCommand(input: unknown): string {
  const i = inputOf({ input });
  const raw = i.command ?? i.cmd ?? i.script;
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && raw.every((w) => typeof w === 'string')) {
    const words = raw as string[];
    if (words.length >= 3 && /^-\w*c$/.test(words[1])) return words[words.length - 1].trim();
    return words.join(' ').trim();
  }
  return '';
}

type ShellKind = 'git' | 'check' | 'guidance' | 'explore' | 'run';

const WRAPPERS = new Set(['sudo', 'time', 'env', 'nohup', 'command', 'exec', '&', 'call', 'npx', 'bunx', 'pnpx']);
const NOISE = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'export', 'set', 'source', '.', 'echo', 'write-host', 'write-output', 'true', ':', 'sleep', 'clear', 'cls']);
const CHECK_PROGS = new Set([
  'vitest', 'jest', 'pytest', 'tsc', 'vue-tsc', 'eslint', 'mypy', 'ruff', 'mocha', 'rspec', 'phpunit',
  'swiftlint', 'ktlint', 'golangci-lint', 'biome', 'playwright', 'tox', 'nox', 'stylelint', 'unittest',
]);
const SHOW_PROGS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'type', 'get-content', 'gc', 'ls', 'dir', 'tree', 'get-childitem', 'gci']);
const LOOK_PROGS = new Set([...SHOW_PROGS, 'find', 'fd', 'rg', 'grep', 'ag', 'ack', 'wc', 'select-string', 'sls', 'stat', 'file', 'realpath', 'pwd', 'which', 'where', 'get-item', 'test-path', 'du']);
const SEARCH_PROGS = new Set(['find', 'fd', 'rg', 'grep', 'ag', 'ack', 'select-string', 'sls']);
const PM = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const INSTALL = new Set(['install', 'i', 'add', 'ci', 'uninstall', 'remove', 'rm', 'update', 'upgrade', 'init', 'create', 'exec', 'dlx']);
const SCRIPT_RE = /^(?:test|t|tests|lint|typecheck|type-check|build|check|verify|e2e)(?::[\w:.-]+)?$/;

/** A word without the quotes around it (a loop, not a regex: commands come from the model). */
function unquote(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && (word[start] === '"' || word[start] === "'")) start++;
  while (end > start && (word[end - 1] === '"' || word[end - 1] === "'")) end--;
  return word.slice(start, end);
}

/** The words of one command, with env assignments and wrappers (`sudo`, `npx`) taken off the front. */
function words(segment: string): string[] {
  const w = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
  while (w.length) {
    if (/^[a-z_][a-z0-9_]*=/i.test(w[0])) {
      w.shift();
    } else if (WRAPPERS.has(w[0].toLowerCase())) {
      w.shift();
      // `npx --yes vitest`: the wrapper's own flags go too.
      while (w.length && w[0].startsWith('-')) w.shift();
    } else break;
  }
  return w;
}

/** A program's bare name: `./node_modules/.bin/vitest`, `.\gradlew.bat` and `C:\…\git.exe` read as `vitest`, `gradlew`, `git`. */
function progName(word: string): string {
  return pathLeaf(word).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|sh)$/, '');
}

function segmentKind(segment: string): ShellKind | null {
  const w = words(segment);
  if (!w.length) return null;
  const prog = progName(w[0]);
  const args = w.slice(1);
  const lower = args.map((a) => a.toLowerCase());
  const plain = lower.filter((a) => !a.startsWith('-') && !a.startsWith('+'));
  const first = plain[0] ?? '';
  if (NOISE.has(prog)) return null;
  if (prog === 'git' || prog === 'gh') return 'git';
  if (checkCommand(prog, lower, plain, first)) return 'check';
  if (LOOK_PROGS.has(prog)) {
    // `cat > notes.md <<EOF` writes a file.
    if (args.some((a) => a.startsWith('>'))) return 'run';
    if (!SHOW_PROGS.has(prog)) return 'explore';
    const paths = args.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));
    return paths.length && paths.every(isGuidancePath) ? 'guidance' : 'explore';
  }
  return 'run';
}

function checkCommand(prog: string, lower: string[], plain: string[], first: string): boolean {
  if (CHECK_PROGS.has(prog)) return true;
  if (PM.has(prog)) {
    if (INSTALL.has(first)) return false;
    return plain.some((a) => SCRIPT_RE.test(a) || CHECK_PROGS.has(a));
  }
  switch (prog) {
    case 'cargo': return ['test', 'build', 'check', 'clippy', 'nextest', 'bench'].includes(first);
    case 'go': return ['test', 'build', 'vet'].includes(first);
    case 'swift': case 'dotnet': return ['test', 'build'].includes(first);
    case 'deno': return ['test', 'check', 'lint'].includes(first);
    case 'mvn': case 'mvnw': return plain.some((a) => ['test', 'verify', 'package', 'compile', 'install'].includes(a));
    case 'gradle': case 'gradlew': return plain.some((a) => /test|build|assemble|lint|check/.test(a));
    case 'make': case 'just': return !first || ['test', 'check', 'build', 'lint', 'all'].includes(first);
    case 'xcodebuild': return plain.some((a) => ['test', 'build', 'build-for-testing', 'test-without-building', 'analyze'].includes(a));
    case 'python': case 'python3': case 'py': case 'uv': case 'poetry': case 'pipenv':
      return plain.some((a) => CHECK_PROGS.has(a));
    case 'node': return lower.includes('--test');
    default: return false;
  }
}

/** The commands a shell line runs, split on `&&`, `||`, `;`, `|` and newlines. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * A shell command's purpose: git when it starts with `git`/`gh`, a check when
 * any part runs tests, a build, a linter or a type check, guidance or explore
 * when every part only reads (`cat`, `ls`, `rg`), else run.
 */
function shellPurpose(command: string): ToolPurpose {
  const kinds = segments(command).map(segmentKind).filter((k): k is ShellKind => k !== null);
  if (!kinds.length) return 'run';
  if (kinds[0] === 'git') return 'git';
  if (kinds.includes('check')) return 'check';
  if (kinds.includes('git')) return 'git';
  if (kinds.every((k) => k === 'guidance')) return 'guidance';
  if (kinds.every((k) => k === 'guidance' || k === 'explore')) return 'explore';
  return 'run';
}

/** What one call is for. */
export function toolPurpose(call: { name: string; input?: unknown }): ToolPurpose {
  if (isMcp(call.name)) return 'other';
  const k = key(call.name);
  if (DELEGATE.has(k)) return 'delegate';
  if (PLAN.has(k)) return 'plan';
  if (WEB.has(k)) return 'web';
  if (EDIT.has(k)) return 'edit';
  if (READ.has(k) || LIST.has(k) || SEARCH.has(k)) {
    const paths = pathsOf(call);
    return paths.length && paths.every(isGuidancePath) ? 'guidance' : 'explore';
  }
  if (SHELL.has(k)) return shellPurpose(shellCommand(call.input));
  return 'other';
}

/**
 * The goal a call states for itself: Claude Code's Bash and Task send a short
 * `description` ("Run the desktop tests"). MCP tools are skipped, because their
 * `description` is often data (an issue body) rather than a goal, and so is
 * anything too long or multi-line to be one.
 */
export function toolGoal(call: { name: string; input?: unknown }): string {
  if (isMcp(call.name) || EDIT.has(key(call.name))) return '';
  const input = inputOf(call);
  const raw = typeof input.description === 'string' ? input.description : typeof input.intent === 'string' ? input.intent : '';
  const text = raw.trim();
  if (!text || text.length > 120 || text.includes('\n')) return '';
  return text.replace(/\s+/g, ' ').replace(/[.]+$/, '');
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/** Up to three names in full; more than that is the first two and `+N`. */
function nameList(names: string[]): string {
  const distinct = [...new Set(names)];
  if (distinct.length <= 3) return distinct.join(', ');
  return `${distinct.slice(0, 2).join(', ')} +${distinct.length - 2}`;
}

function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

function checkKind(call: PurposeCall): 'test' | 'build' | 'lint' {
  const k = key(call.name);
  const text = SHELL.has(k) ? shellCommand(call.input).toLowerCase() : k;
  if (/\btest|vitest|jest|pytest|mocha|rspec|phpunit|playwright|unittest|\be2e\b/.test(text)) return 'test';
  if (/\bbuild|assemble|\bmake\b|compile|package/.test(text)) return 'build';
  return 'lint';
}

/** A git step's verb, past and present, for the git headline. */
const GIT_ACTIONS: Record<string, [string, string]> = {
  commit: ['committed', 'committing'],
  push: ['pushed', 'pushing'],
  pull: ['pulled', 'pulling'],
  switch: ['switched branches', 'switching branches'],
  merge: ['merged', 'merging'],
  rebase: ['rebased', 'rebasing'],
  stash: ['stashed changes', 'stashing changes'],
  worktree: ['set up a worktree', 'setting up a worktree'],
  'pr-create': ['opened a PR', 'opening a PR'],
  'pr-merge': ['queued the PR', 'queuing the PR'],
  'pr-read': ['checked the PR', 'checking the PR'],
  'issue-create': ['filed an issue', 'filing an issue'],
  'issue-read': ['read the issues', 'reading the issues'],
  add: ['staged changes', 'staging changes'],
  look: ['checked the changes', 'checking the changes'],
  other: ['used git', 'using git'],
};
/** Steps that only lead up to another one, so they drop out when it is there. */
const MINOR_GIT = new Set(['add', 'look', 'other', 'pr-read', 'issue-read']);

function gitActions(calls: PurposeCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    for (const seg of segments(shellCommand(call.input))) {
      const w = words(seg).map((x) => x.toLowerCase());
      const prog = w.length ? progName(w[0]) : '';
      if (prog !== 'git' && prog !== 'gh') continue;
      // `git -C path commit`: skip the global options and their values.
      let i = 1;
      while (i < w.length && w[i].startsWith('-')) i += w[i] === '-c' || w[i] === '-C' ? 2 : 1;
      const sub = w[i] ?? '';
      const obj = w[i + 1] ?? '';
      let action: string;
      if (prog === 'gh') {
        if (sub === 'pr') action = obj === 'create' ? 'pr-create' : obj === 'merge' ? 'pr-merge' : 'pr-read';
        else if (sub === 'issue') action = obj === 'create' ? 'issue-create' : 'issue-read';
        else if (sub === 'run' || sub === 'api') action = 'pr-read';
        else action = 'other';
      } else if (sub === 'commit' || sub === 'push' || sub === 'merge' || sub === 'rebase' || sub === 'stash' || sub === 'worktree') action = sub;
      else if (sub === 'pull' || sub === 'fetch') action = 'pull';
      else if (sub === 'checkout' || sub === 'switch' || sub === 'branch') action = 'switch';
      else if (sub === 'add') action = 'add';
      else if (['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'remote'].includes(sub)) action = 'look';
      else action = 'other';
      if (!out.includes(action)) out.push(action);
    }
  }
  const major = out.filter((a) => !MINOR_GIT.has(a));
  if (major.length) return major;
  for (const a of ['pr-read', 'issue-read', 'add', 'look']) if (out.includes(a)) return [a];
  return ['other'];
}

function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function distinctPaths(calls: PurposeCall[]): string[] {
  return [...new Set(calls.flatMap(pathsOf))];
}

/** The purpose's own headline for these calls, ignoring any stated goal. */
export function purposePhrase(purpose: ToolPurpose, calls: PurposeCall[], running = false): string {
  const t = (past: string, present: string) => (running ? present : past);
  const n = calls.length;
  switch (purpose) {
    case 'guidance': return t("Read the project's guidance", "Reading the project's guidance");
    case 'explore': return t('Looked through the code', 'Looking through the code');
    case 'edit': {
      const files = distinctPaths(calls).length || n;
      return `${t('Edited', 'Editing')} ${plural(files, '1 file', 'files')}`;
    }
    case 'check': {
      const kinds = new Set(calls.map(checkKind));
      if (kinds.size === 1 && kinds.has('test')) return t('Ran the tests', 'Running the tests');
      if (kinds.size === 1 && kinds.has('build')) return t('Built the app', 'Building the app');
      return t('Ran the checks', 'Running the checks');
    }
    case 'run': return `${t('Ran', 'Running')} ${plural(n, 'a command', 'commands')}`;
    case 'git': return cap(joinPhrases(gitActions(calls).map((a) => GIT_ACTIONS[a][running ? 1 : 0])));
    case 'web': {
      const searches = calls.filter((c) => WEB_SEARCH.has(key(c.name))).length;
      if (searches) return t('Searched the web', 'Searching the web');
      return `${t('Read', 'Reading')} ${plural(n, 'a page', 'pages')}`;
    }
    case 'plan': return t('Updated the plan', 'Updating the plan');
    case 'delegate': return `${t('Delegated', 'Delegating')} ${plural(n, 'a task', 'tasks')}`;
    default: return n === 1 ? `${t('Used', 'Using')} ${calls[0].name}` : `${t('Used', 'Using')} ${n} tools`;
  }
}

function host(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, '') : url;
}

/** The quiet line under a headline: what was touched, or how a check went. */
function purposeDetail(purpose: ToolPurpose, calls: PurposeCall[], running: boolean): string {
  switch (purpose) {
    case 'guidance':
    case 'edit':
      return nameList(distinctPaths(calls).map(pathLeaf));
    case 'explore': {
      let files = 0, folders = 0, searches = 0, commands = 0;
      for (const c of calls) {
        const k = key(c.name);
        if (READ.has(k)) files++;
        else if (LIST.has(k)) folders++;
        else if (SEARCH.has(k)) searches++;
        else if (segments(shellCommand(c.input)).some((seg) => SEARCH_PROGS.has(progName(words(seg)[0] ?? '')))) searches++;
        else commands++;
      }
      return [
        files && plural(files, '1 file', 'files'),
        folders && plural(folders, '1 folder', 'folders'),
        searches && plural(searches, '1 search', 'searches'),
        commands && plural(commands, '1 command', 'commands'),
      ].filter(Boolean).join(', ');
    }
    case 'check': {
      const failed = calls.filter((c) => c.failed).length;
      if (!running) return failed ? `${failed} failed` : 'passed';
      return oneLine(shellCommand(calls[0].input) || calls[0].name);
    }
    case 'run':
    case 'git':
      return oneLine(shellCommand(calls[0].input));
    case 'web': {
      const query = calls.map((c) => str(inputOf(c).query)).find(Boolean);
      if (query) return oneLine(query);
      return nameList(calls.map((c) => str(inputOf(c).url)).filter((u): u is string => !!u).map(host));
    }
    case 'other':
      return nameList(calls.map((c) => c.name));
    default:
      return '';
  }
}

export interface PurposeHeadline {
  /** The goal: the calls' own stated one, else the purpose's phrase. */
  headline: string;
  /** What was touched, how a check went, and how many failed. */
  detail: string;
  failed: number;
}

/**
 * The headline and detail line for a run of same-purpose calls. Present tense
 * while the run is live ("Reading the project's guidance"), past once it ends.
 * When the calls state different goals, the headline is the first one and
 * "and N more".
 */
export function purposeHeadline(purpose: ToolPurpose, calls: PurposeCall[], running = false): PurposeHeadline {
  const goals = [...new Set(calls.map(toolGoal).filter(Boolean))];
  const headline = goals.length
    ? goals.length > 1 ? `${goals[0]} and ${goals.length - 1} more` : goals[0]
    : purposePhrase(purpose, calls, running);
  const failed = calls.filter((c) => c.failed).length;
  let detail = purposeDetail(purpose, calls, running);
  if (failed && !(purpose === 'check' && !running)) detail = [detail, `${failed} failed`].filter(Boolean).join(' · ');
  return { headline, detail, failed };
}

/** The short form of a purpose in a whole run's summary ("read guidance"). */
function summaryPhrase(purpose: ToolPurpose, calls: PurposeCall[]): string {
  if (purpose === 'guidance') return 'read guidance';
  return lowerFirst(purposePhrase(purpose, calls));
}

/**
 * A whole run of calls in one line, by purpose in the order each first
 * appears: "Read guidance, looked through the code, edited 3 files". Stated
 * goals are left out here; they belong to the purpose rows.
 */
export function summarizePurposes(calls: PurposeCall[]): string {
  const by = new Map<ToolPurpose, PurposeCall[]>();
  for (const c of calls) {
    const p = toolPurpose(c);
    by.set(p, [...(by.get(p) ?? []), c]);
  }
  const parts = [...by].map(([p, cs]) => summaryPhrase(p, cs));
  const shown = parts.length > 4 ? [...parts.slice(0, 3), `and ${parts.length - 3} more`] : parts;
  return cap(shown.join(', '));
}

/** One row of a grouped run: a run of two or more same-purpose calls, or an item on its own. */
export type PurposeRun<T> =
  | { kind: 'group'; purpose: ToolPurpose; items: T[]; calls: PurposeCall[] }
  | { kind: 'single'; item: T };

/**
 * Fold adjacent same-purpose calls into groups.
 *
 * `callOf` returns the call an item is, or undefined for an item that is not a
 * call (a thought between calls), which joins a group only when calls of the
 * same purpose come on both sides of it. A call with `standalone` set (one
 * waiting for approval, a delegation shown its own way) and every question for
 * the person stay rows of their own, and a group of one call is a plain row.
 * Nothing is reordered or dropped: the items come back in order.
 */
export function groupByPurpose<T>(
  items: readonly T[],
  callOf: (item: T) => (PurposeCall & { standalone?: boolean }) | undefined,
): PurposeRun<T>[] {
  const out: PurposeRun<T>[] = [];
  let group: { purpose: ToolPurpose; items: T[]; calls: PurposeCall[] } | null = null;
  let held: T[] = [];
  const flush = () => {
    if (group) {
      if (group.calls.length > 1) out.push({ kind: 'group', ...group });
      else for (const item of group.items) out.push({ kind: 'single', item });
      group = null;
    }
    for (const item of held) out.push({ kind: 'single', item });
    held = [];
  };
  for (const item of items) {
    const call = callOf(item);
    if (!call) {
      if (group) held.push(item);
      else out.push({ kind: 'single', item });
      continue;
    }
    if (call.standalone || needsUser(call)) {
      flush();
      out.push({ kind: 'single', item });
      continue;
    }
    const purpose = toolPurpose(call);
    if (group && group.purpose === purpose) {
      group.items.push(...held, item);
      group.calls.push(call);
      held = [];
      continue;
    }
    flush();
    group = { purpose, items: [item], calls: [call] };
  }
  flush();
  return out;
}

/** Pull-request types + helpers for the in-chat PR card, diff pane, and badges.
 *
 * Nekko Agent doesn't track PRs itself; a chat "has" a PR when a GitHub PR URL shows
 * up in its transcript (the agent runs `gh pr create`, the URL lands in tool
 * output, or the user pastes one). We extract those URLs and hydrate live state
 * via the `gh` CLI, falling back to the GitHub REST API with the connector PAT.
 */

export type PrState = 'open' | 'merged' | 'closed';

/** Rolled-up CI status across a PR's head-commit checks. */
export type PrChecks = 'passing' | 'failing' | 'pending' | 'none';

export interface PrInfo {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName?: string;
  baseRefName?: string;
  /** Native GitHub stack membership, never inferred from branch names. */
  stack?: { number: number; size: number };
  /** 'approved' | 'changes_requested' | 'review_required' | null (gh only). */
  reviewDecision?: string | null;
  checks: PrChecks;
  createdAt?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  updatedAt?: string | null;
  /** Local fetch time in epoch milliseconds, independent of GitHub updatedAt. */
  checkedAt?: number;
  /** Absent when the complete head check connection could not be read. */
  checkProgress?: {
    total: number;
    /** Successful, neutral or skipped checks. Failures are counted separately. */
    completed: number;
    pending: number;
    failing: number;
    unknown: number;
    items: Array<{ name: string; state: 'completed' | 'pending' | 'failing' | 'unknown'; link: string | null }>;
  };
  /** Review threads only, not approvals, reviews or issue comments. Absent on read failure. */
  reviewThreads?: { total: number; resolved: number; unresolved: number };
  /** Where the live state came from, for graceful-degradation messaging. */
  source: 'gh' | 'api';
}

export type PrFileStatus = 'added' | 'removed' | 'modified' | 'renamed';

export interface PrDiffFile {
  path: string;
  /** Prior path for renames. */
  oldPath?: string;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  /** Unified-diff hunks (from the first `@@`), parsed client-side for rendering. */
  patch: string;
}

export interface PrDiff {
  url: string;
  files: PrDiffFile[];
  /** True when the diff was capped (very large PR). */
  truncated?: boolean;
}

export type PrAction = 'approve' | 'close' | 'merge' | 'reopen';

export interface PrActionResult {
  ok: boolean;
  message: string;
  /** Refreshed PR state after the action, when it could be re-read. */
  pr?: PrInfo;
}

/** `pr:create`: a PR from the workspace's current branch, which must already be pushed. */
export interface PrCreateOptions {
  title: string;
  body?: string;
  /** The branch to merge into; the repository's default when omitted. */
  base?: string;
  draft?: boolean;
}

export interface PrCreateResult {
  ok: boolean;
  message: string;
  url?: string;
  /** The new PR's live state, when it could be read. */
  pr?: PrInfo;
}

/** gh's bucket for one check. */
export type PrCheckState = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export interface PrCheck {
  name: string;
  state: PrCheckState;
  workflow: string | null;
  link: string | null;
  description: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** `pr:checks`: each check on the PR's head commit, and their rollup. */
export interface PrCheckList {
  url: string;
  checks: PrChecks;
  items: PrCheck[];
  source: 'gh' | 'api';
}

const PR_URL_RE =/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

/**
 * Every unique GitHub PR URL mentioned in a blob of text. A match ends at the
 * PR number, so punctuation after the URL (a closing paren, a full stop) is
 * never part of it.
 */
export function extractPrUrls(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(PR_URL_RE)) out.add(m[0]);
  return [...out];
}

/** Parse owner / repo / number out of a GitHub PR URL. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/**
 * A heredoc's opening marker through its closing delimiter line, and the line
 * break before a `)` that closes the `$(cat <<EOF ...)` it sits in.
 */
const HEREDOC_BODY_RE = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1\r?\n[\s\S]*?\r?\n[ \t]*\2[ \t]*(?:\r?\n[ \t]*(?=\))|(?=\r?\n|$))/g;

/** One leading `cd <dir> && ` (a plain or quoted path, nothing else). */
const LEADING_CD_RE = /^cd\s+(?:"[^"`$]*"|'[^']*'|[^\s;&|`$"']+)\s*&&\s*/;

/** A trailing `2>&1`, `| tail -N` or `| head -N`, or both, that only trims the output. */
const TRAILING_TRIM_RE = /(?:\s+2>&1)?(?:\s*\|\s*(?:tail|head)\s+(?:-n\s*)?-?\d+)?\s*$/;

/** The slice of a chat message the PR scans read. */
type ScannedMessage = {
  role?: string; content?: string;
  toolCalls?: Array<{ id: string; name: string; input?: Record<string, unknown> }>;
  toolResult?: { toolCallId?: string; output?: string; isError?: boolean };
};

/**
 * Every successful run of a single `gh` command by the agent's shell tool, with
 * the command normalized. Anything else (a failed run, a script, a batch, a
 * pipe that rewrites the output) is skipped: its output cannot be trusted to
 * come from that one command.
 */
function* ghRuns(messages: ScannedMessage[]): Generator<{ index: number; toolCallId: string; command: string; output: string }> {
  const calls = new Map(messages.flatMap(m => (m.toolCalls ?? []).map(c => [c.id, c] as const)));
  for (let index = 0; index < messages.length; index++) {
    const result = messages[index].toolResult;
    const call = result?.toolCallId ? calls.get(result.toolCallId) : undefined;
    // Nekko's `bash`, or Claude Code's own `Bash` in a Claude Agent chat.
    if (!call || result?.isError || (call.name !== 'bash' && call.name !== 'Bash')) continue;
    // A heredoc body (how Claude Code passes `--body`) is the command's text,
    // not more commands: it is set aside before the checks below. So is one
    // leading `cd <dir> &&`, how Claude Code runs a command in a worktree.
    // A trailing `2>&1 | tail -5` only trims what it printed.
    const command = String(call.input?.command ?? '').replace(HEREDOC_BODY_RE, '<<HEREDOC').trim()
      .replace(LEADING_CD_RE, '').replace(TRAILING_TRIM_RE, '');
    // Do not classify strings embedded in scripts, quoted fixtures, or shell
    // batches as creation. Fail closed when output provenance is ambiguous.
    if (!command.startsWith('gh ') || /[\r\n;&|`]/.test(command)) continue;
    yield { index, toolCallId: call.id, command, output: result?.output ?? '' };
  }
}

const PR_LINE_RE = /^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

/** The PR a successful creation command made, or undefined. */
function createdPrUrl(command: string, output: string): string | undefined {
  const create = /^gh\s+pr\s+create(?:\s|$)/.test(command);
  const api = /^gh\s+api\s+(?:repos\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls(?:\s|$)/.test(command)
    && /(?:-X|--method)\s+POST\b/.test(command);
  if (!create && !api) return;
  // `gh pr create` prints the PR's URL last, after any warnings (with `2>&1`).
  const trimmed = output.trim();
  const value = create ? trimmed.split(/\r?\n/).pop()!.trim() : trimmed;
  return PR_LINE_RE.test(value) ? value : undefined;
}

/** Only successful PR-creation tool results attach PRs to this chat. */
export function collectSessionPrUrls(messages: ScannedMessage[]): string[] {
  const urls = new Set<string>();
  for (const { command, output } of ghRuns(messages)) {
    const url = createdPrUrl(command, output);
    if (url) urls.add(url);
  }
  return [...urls];
}

/**
 * A PR lifecycle step the agent took, as the chat shows it. Requested and
 * completed steps stay distinct: `merge-requested`, `auto-merge` and
 * `merge-queued` never mean the PR merged.
 * - `merge-requested`: `gh pr merge` succeeded without saying what it did
 *   (it prints nothing when not on a terminal), so it may have merged, armed
 *   auto-merge or queued the PR.
 */
export type PrLifecycleEvent =
  | 'created' | 'created-draft' | 'draft' | 'ready'
  | 'merge-requested' | 'auto-merge' | 'merge-queued' | 'merged'
  | 'closed' | 'reopened';

/** One confirmed lifecycle step, anchored to the tool result that confirmed it. */
export interface PrLifecycleHit {
  /** Index of the tool-result message in the scanned list. */
  index: number;
  toolCallId: string;
  url: string;
  event: PrLifecycleEvent;
}

/** Flags of each `gh pr` verb that take a value, so a value is never read as the PR selector. */
const VALUE_FLAGS: Record<string, string[]> = {
  ready: [],
  merge: ['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit'],
  close: ['-c', '--comment'],
  reopen: ['-c', '--comment'],
};

/** Shell words, honouring quotes. Good enough for one `gh` command line. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  for (const m of command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

const REF = '([A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+)#(\\d+)';
/** gh's own confirmation lines (cli/cli pkg/cmd/pr), success icon included. */
const CONFIRMATIONS: Array<{ verb: string; undo?: boolean; re: RegExp; event: PrLifecycleEvent }> = [
  { verb: 'ready', undo: false, re: new RegExp(`^✓ Pull request ${REF} is marked as "ready for review"$`), event: 'ready' },
  { verb: 'ready', undo: true, re: new RegExp(`^✓ Pull request ${REF} is converted to "draft"$`), event: 'draft' },
  { verb: 'close', re: new RegExp(`^✓ Closed pull request ${REF} \\(`), event: 'closed' },
  { verb: 'reopen', re: new RegExp(`^✓ Reopened pull request ${REF} \\(`), event: 'reopened' },
  { verb: 'merge', re: new RegExp(`^✓ Pull request ${REF} will be added to the merge queue for \\S+ when ready$`), event: 'merge-queued' },
  { verb: 'merge', re: new RegExp(`^✓ Pull request ${REF} will be automatically merged(?: via \\w+)? when all requirements are met$`), event: 'auto-merge' },
  { verb: 'merge', re: new RegExp(`^✓ (?:Merged|Squashed and merged|Rebased and merged) pull request ${REF} \\(`), event: 'merged' },
];

/**
 * Lines a silent successful `gh pr merge` may still leave: the shell tool's
 * empty-output and stderr markers, Claude Code's cwd note, and gh's one
 * non-fatal warning that is not about the PR's state.
 */
const MERGE_NOISE_RE = /^(?:\(no output\)|\(Bash completed with no output\)|\[stderr\]|Shell cwd was reset to .*|! The merge strategy for \S+ is set by the merge queue)$/;

/** A PR reference or URL anywhere in a line. */
const OTHER_PR_RE = new RegExp(`${REF}|https?://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\\d+`);

const prUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

/**
 * The PR lifecycle steps the agent confirmably took in this chat: creating a
 * PR (draft or not), marking it ready or back to draft, asking for a merge,
 * and closing or reopening it.
 *
 * A step counts only when its tool result says which PR it touched: a URL, or
 * gh's own `owner/repo#N` confirmation line. `gh pr merge` prints nothing off
 * a terminal, so a silent success counts only when its selector names the PR:
 * a URL, `-R owner/repo` with a number, or a bare number matching exactly one
 * PR this chat already knows (`known`, plus every PR it created). A failed
 * run, a gh warning such as "already merged", a second PR in the output, or a
 * confirmation that disagrees with the selector is ignored.
 */
export function collectPrLifecycle(messages: ScannedMessage[], known: Iterable<string> = []): PrLifecycleHit[] {
  const hits: PrLifecycleHit[] = [];
  const knownUrls = new Map<string, string>();
  const remember = (url: string) => { if (!knownUrls.has(url.toLowerCase())) knownUrls.set(url.toLowerCase(), url); };
  for (const url of known) remember(url);
  const runs = [...ghRuns(messages)];
  for (const run of runs) {
    const url = createdPrUrl(run.command, run.output);
    if (url) remember(url);
  }
  // Prefer the spelling the chat already uses, so rows and live PR info share a key.
  const canonical = (url: string) => knownUrls.get(url.toLowerCase()) ?? url;

  for (const { index, toolCallId, command, output } of runs) {
    const created = createdPrUrl(command, output);
    const words = shellWords(command);
    if (created) {
      const draft = words[1] === 'pr' && words.some((w) => w === '--draft' || w === '-d');
      hits.push({ index, toolCallId, url: created, event: draft ? 'created-draft' : 'created' });
      continue;
    }
    const verb = words[1] === 'pr' ? words[2] : undefined;
    if (!verb || !(verb in VALUE_FLAGS)) continue;

    // The selector, `-R owner/repo` and the flags that change what the verb does.
    let selector: string | undefined;
    let repo: string | undefined;
    const flags = new Set<string>();
    let ambiguous = false;
    for (let i = 3; i < words.length; i++) {
      const word = words[i];
      const [name, inline] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined];
      if (name === '-R' || name === '--repo') { repo = inline ?? words[++i]; continue; }
      if (VALUE_FLAGS[verb].includes(name)) { if (inline === undefined) i++; continue; }
      if (word.startsWith('-')) { flags.add(name); continue; }
      if (selector !== undefined) ambiguous = true;
      selector = word;
    }
    if (ambiguous || (verb === 'merge' && flags.has('--disable-auto'))) continue;
    const undo = flags.has('--undo');
    const selectorPr = selector ? parsePrUrl(selector) : null;
    const selectorNumber = selectorPr?.number ?? (selector && /^#?\d+$/.test(selector) ? Number(selector.replace('#', '')) : undefined);
    const selectorRepo = selectorPr ? `${selectorPr.owner}/${selectorPr.repo}` : repo;
    if (selectorPr && repo && repo.toLowerCase() !== selectorRepo!.toLowerCase()) continue;

    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const confirmations: Array<{ event: PrLifecycleEvent; repo: string; number: number; line: string }> = [];
    for (const line of lines) {
      for (const c of CONFIRMATIONS) {
        if (c.verb !== verb || (c.undo !== undefined && c.undo !== undo)) continue;
        const m = line.match(c.re);
        if (m) confirmations.push({ event: c.event, repo: m[1], number: Number(m[2]), line });
      }
    }

    if (confirmations.length > 1) continue;
    if (confirmations.length === 1) {
      const c = confirmations[0];
      // Any other PR reference in the output makes it unclear what was touched.
      const others = lines.filter((l) => l !== c.line).join('\n');
      if (OTHER_PR_RE.test(others)) continue;
      if (selectorNumber !== undefined && selectorNumber !== c.number) continue;
      if (selectorRepo && selectorRepo.toLowerCase() !== c.repo.toLowerCase()) continue;
      hits.push({ index, toolCallId, url: canonical(prUrl(c.repo, c.number)), event: c.event });
      continue;
    }

    // No confirmation line: only a silent `gh pr merge` can still count.
    if (verb !== 'merge' || !lines.every((l) => MERGE_NOISE_RE.test(l))) continue;
    let url: string | undefined;
    if (selectorRepo && selectorNumber !== undefined) url = canonical(prUrl(selectorRepo, selectorNumber));
    else if (selectorNumber !== undefined) {
      const matches = [...knownUrls.values()].filter((u) => parsePrUrl(u)?.number === selectorNumber);
      if (matches.length === 1) url = matches[0];
    }
    if (url) hits.push({ index, toolCallId, url, event: 'merge-requested' });
  }
  return hits;
}

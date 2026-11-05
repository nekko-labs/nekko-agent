/** Pull-request types + helpers for the in-chat PR card, diff pane, and badges.
 *
 * A chat attaches PRs through confirmed, successful GitHub CLI interactions,
 * not arbitrary URL mentions. Live state is hydrated separately via the `gh`
 * CLI, falling back to the GitHub REST API with the connector PAT.
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

/** Transcript events, independent of the card's subsequently fetched live state. */
export type PrEvent = 'created' | 'created-draft' | 'auto-merge' | 'open' | 'closed' | 'merged' | 'draft' | 'ready' | 'queued'
  | 'merge-requested' | 'reopened' | 'updated' | 'reviewed' | 'viewed';

type PrMessages = Array<{
  role?: string; content?: string;
  toolCalls?: Array<{ id: string; name: string; input?: Record<string, unknown> }>;
  toolResult?: { toolCallId?: string; output?: string; isError?: boolean };
}>;

/** Canonical PR identity; neither a branch name nor a URL embedded in prose. */
function canonicalPrUrl(value: string): string | undefined {
  const match = value.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:[/?#][^\s]*)?$/);
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
}

/** A small shell lexer, not a shell interpreter. Quoted bodies stay arguments. */
function prCommandWords(raw: string): string[] | undefined {
  // Only the established create-body heredoc form may contain substitution.
  let command = raw.replace(/(["'])?\$\(cat\s+(<<-?\s*(['"]?)([A-Za-z_]\w*)\3\r?\n[\s\S]*?\r?\n[ \t]*\4[ \t]*\r?\n[ \t]*\))\1/g, 'HEREDOC_BODY').trim();
  // Bare heredocs are retained for compatibility, but are never URL evidence.
  command = command.replace(HEREDOC_BODY_RE, 'HEREDOC_BODY')
    .replace(LEADING_CD_RE, '').replace(TRAILING_TRIM_RE, '');
  const words: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\r' || ch === '\n') return undefined;
    if (ch === '\\' && quote !== "'") {
      const next = command[++i];
      if (!next || /[\r\n]/.test(next)) return undefined;
      word += next;
      started = true;
    } else if (quote) {
      if (ch === quote) quote = '';
      else {
        if (quote === '"' && /[\x24\x60]/.test(ch)) return undefined;
        word += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      if (/[;&|`$<>#()]/.test(ch)) return undefined;
      word += ch;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words[0] === 'gh' ? words : undefined;
}

const PR_VALUE_FLAGS = new Set([
  '--title', '-t', '--body', '-b', '--body-file', '-F', '--base', '-B', '--head', '-H',
  '--reviewer', '-r', '--assignee', '-a', '--label', '-l', '--milestone', '-m', '--project', '-p',
  '--json', '--jq', '-q', '--template', '--match-head-commit', '--recover', '--color',
  '--add-assignee', '--remove-assignee', '--add-label', '--remove-label',
  '--add-project', '--remove-project', '--add-reviewer', '--remove-reviewer',
]);
const PR_SWITCHES = new Set([
  '--auto', '--undo', '--draft', '--ready', '--squash', '--merge', '--rebase', '--delete-branch', '-d',
  '--disable-auto', '--admin', '--approve', '--request-changes', '--comment', '--fill',
  '--fill-first', '--fill-verbose', '--web', '-w', '--comments', '-c', '--watch',
  '--fail-fast', '--required', '--patch', '--stat', '--name-only', '--no-maintainer-edit',
]);
const PR_COMMANDS = new Set(['create', 'merge', 'ready', 'close', 'reopen', 'edit', 'review', 'view', 'checks', 'diff']);

type PrCommand = { action: string; target?: string; repo?: string; switches: Set<string>; outputEvidence: boolean };

function parsePrCommand(words: string[]): PrCommand | undefined {
  let kind = '';
  let action = '';
  let repo: string | undefined;
  let method = '';
  let outputEvidence = true;
  const positional: string[] = [];
  const switches = new Set<string>();
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const [flag, ...parts] = word.split('=');
    const inline = parts.length ? parts.join('=') : undefined;
    if (flag === '--repo' || flag === '-R' || /^-R.+/.test(word)) {
      const value = /^-R.+/.test(word) && flag !== '-R' ? word.slice(2).replace(/^=/, '') : inline ?? words[++i];
      if (!value || !/^(?:github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return undefined;
      const nextRepo = value.replace(/^github\.com\//, '');
      if (repo && repo.toLowerCase() !== nextRepo.toLowerCase()) return undefined;
      repo = nextRepo;
    } else if (!kind && (word === 'pr' || word === 'api')) {
      kind = word;
    } else if (kind === 'pr' && !action && PR_COMMANDS.has(word)) {
      action = word;
    } else if (kind === 'api' && (flag === '-X' || flag === '--method')) {
      method = inline ?? words[++i];
    } else if (kind === 'pr' && action === 'review' && (word === '-a' || word === '-r')) {
      switches.add(word);
    } else if ((kind === 'api' && ['-f', '-F', '--field', '--raw-field', '-H', '--header', '--input', '--jq', '-q', '--template', '-t'].includes(flag))
      || (kind === 'pr' && action === 'close' && (flag === '--comment' || flag === '-c'))
      || (kind === 'pr' && action && PR_VALUE_FLAGS.has(flag))) {
      const value = inline ?? words[++i];
      if (value === undefined) return undefined;
      // Formatting expressions can manufacture URLs/state instead of reading it.
      if ((flag === '--jq' || flag === '-q') && value !== '.url' && value !== '.html_url') outputEvidence = false;
      if (flag === '--template' || (flag === '-t' && (kind === 'api' || ['view', 'checks'].includes(action)))) outputEvidence = false;
    } else if (kind === 'pr' && action && PR_SWITCHES.has(word)) {
      switches.add(word);
    } else if (word.startsWith('-') || !kind || (kind === 'pr' && !action)) {
      // Unknown flags, help and dry-run cannot prove an interaction.
      return undefined;
    } else {
      positional.push(word);
    }
  }
  if (kind === 'api') {
    const match = positional.length === 1 && positional[0].match(/^(?:repos\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pulls$/);
    if (!match || method !== 'POST' || (repo && repo.toLowerCase() !== match[1].toLowerCase())) return undefined;
    return { action: 'create-api', repo: match[1], switches, outputEvidence };
  }
  if (!action || positional.length > 1 || (action === 'create' && positional.length)) return undefined;
  const target = positional[0];
  // Branch selectors require an identifying gh confirmation, never a guessed identity.
  if (target && !/^#?[1-9]\d*$/.test(target) && !canonicalPrUrl(target) && !/^[A-Za-z0-9_./-]+$/.test(target)) return undefined;
  return { action, target, repo, switches, outputEvidence };
}

/** Whether a tool call is an attributable PR command, without reading its output. */
export function isPrInteractionCall(call: { name: string; input?: Record<string, unknown> }): boolean {
  if ((call.name !== 'bash' && call.name !== 'Bash') || typeof call.input?.command !== 'string') return false;
  const words = prCommandWords(call.input.command);
  return !!words && !!parsePrCommand(words);
}

function uniquePrUrls(values: readonly string[]): string[] {
  const urls = new Map<string, string>();
  for (const value of values) {
    const url = canonicalPrUrl(value);
    if (url && !urls.has(url.toLowerCase())) urls.set(url.toLowerCase(), url);
  }
  return [...urls.values()];
}

function outputPrData(output: string): { urls: string[]; state?: string; number?: number; invalid?: boolean } {
  try {
    const value = JSON.parse(output) as Record<string, unknown> | null;
    if (!value || Array.isArray(value) || typeof value !== 'object') return { urls: [] };
    if (value.error || value.errors || (Number(value.status) >= 400 && Number(value.status) < 600)) return { urls: [], invalid: true };
    const url = typeof value.html_url === 'string' ? canonicalPrUrl(value.html_url)
      : typeof value.url === 'string' ? canonicalPrUrl(value.url) : undefined;
    if (value.number !== undefined && (!Number.isSafeInteger(value.number) || Number(value.number) <= 0
      || (url && value.number !== parsePrUrl(url)!.number))) return { urls: [], invalid: true };
    if ((value.url !== undefined || value.html_url !== undefined) && !url) return { urls: [], invalid: true };
    return {
      urls: url ? [url] : [],
      number: typeof value.number === 'number' ? value.number : undefined,
      state: value.state === 'MERGED' || (value.state === 'closed' && typeof value.merged_at === 'string' && Number.isFinite(Date.parse(value.merged_at)))
        ? 'merged' : undefined,
    };
  } catch {
    // Ignore prose/body/diff links. Accept URL-only output and gh's URL/status lines.
    const urls = output.split(/\r?\n/).flatMap(line => {
      const trimmed = line.trim();
      const direct = canonicalPrUrl(trimmed);
      if (direct) return [direct];
      const labelled = trimmed.match(/^(?:url:|View this pull request on GitHub:)\s*(https?:\/\/\S+)$/i);
      const status = trimmed.match(/^(?:[✓✔!]\s*)?(?:Added|Merged|Squashed and merged|Rebased and merged|Closed|Reopened|Updated|Marked)\s+(?:pull request|PR)\s+(https?:\/\/\S+)(?:\s|$)/i);
      const url = canonicalPrUrl(labelled?.[1] ?? status?.[1] ?? '');
      if (url) return [url];
      // gh's own status lines identify numeric commands in the current repo,
      // even when they print no URL. Never mine arbitrary body/diff references.
      const reference = trimmed.match(/^[✓✔!]?\s*(?:(?:Added|Merged|Squashed and merged|Rebased and merged|Closed|Reopened|Updated|Marked)\s+(?:pull request|PR)|Pull request|Auto-merge enabled for pull request)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)\b/i);
      return reference ? [`https://github.com/${reference[1]}/pull/${reference[2]}`] : [];
    });
    return { urls: uniquePrUrls(urls) };
  }
}

/** Even trim pipelines can hide gh's nonzero exit code. Never trust error text. */
function unsuccessfulPrOutput(output: string): boolean {
  return /(?:^|\n)\s*(?:[x✗!]\s*)?(?:error\b|fatal\b|GraphQL:|HTTP\s+[45]\d\d\b|failed\b|denied\b|could not\b|not found\b)/i.test(output)
    || /(?:permission denied|access denied|not authorized|not mergeable|cannot be merged|not permitted|not allowed|merge (?:is |was |request (?:was )?)?(?:blocked|denied)|merge cannot be performed|failed to merge|auto.?merge is not enabled)/i.test(output)
    || /(?:exit(?:ed with)?(?: code| status)?|exit_code)\s*[:=]?\s*[1-9]\d*\b/i.test(output)
    || /(?:command timed out|process (?:is still )?running|session (?:is still )?running|command (?:was )?cancelled)/i.test(output);
}

/** gh warnings report no transition, even when the command exits successfully. */
const PR_NOOP_RE = /(?:^|\n)\s*!?\s*(?:Pull request|PR)\b[^\n]*\b(?:already|was already)\b/i;
const SILENT_MERGE_LINE_RE = /^(?:\(no output\)|\(Bash completed with no output\)|\[stderr\]|Shell cwd was reset to .*|! The merge strategy for \S+ is set by the merge queue)$/;

/** The earlier lifecycle stack's real gh confirmation strings, plus existing CLI variants. */
function confirmedPrEvent(output: string): { action: string; event: PrEvent } | false | undefined {
  const ref = '(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#[1-9]\\d*';
  const confirmations: Array<[string, PrEvent, string]> = [
    ['ready', 'draft', `Pull request ${ref} is (?:converted to "draft"|now marked as draft)$`],
    ['ready', 'ready', `Pull request ${ref} is marked as "?ready for review"?$`],
    ['merge', 'queued', `Pull request ${ref} will be added to the merge queue for \\S+ when ready$`],
    ['merge', 'auto-merge', `(?:Pull request ${ref} will be automatically merged(?: via \\w+)? when all requirements are met|Auto-merge enabled for pull request ${ref})$`],
    ['merge', 'merged', `(?:Squashed and merged|Rebased and merged|Merged) pull request ${ref}(?: \\(|$)`],
    ['close', 'closed', `Closed pull request ${ref}(?: \\(|$)`],
    ['reopen', 'reopened', `Reopened pull request ${ref}(?: \\(|$)`],
  ];
  const hits = output.split(/\r?\n/).flatMap(line => confirmations.flatMap(([action, event, pattern]) =>
    new RegExp('^[✓✔]\\s*' + pattern, 'i').test(line.trim()) ? [{ action, event }] : []));
  return hits.length > 1 ? false : hits[0];
}

function interactionFor(command: PrCommand, output: string, known: readonly string[]): { url: string; event: PrEvent } | undefined {
  if (unsuccessfulPrOutput(output) || PR_NOOP_RE.test(output)) return undefined;
  const confirmed = command.outputEvidence ? confirmedPrEvent(output) : undefined;
  if (confirmed === false || (confirmed && command.switches.has('--disable-auto'))) return undefined;
  if (confirmed && (confirmed.action !== command.action
    || (command.action === 'ready' && (confirmed.event === 'draft') !== command.switches.has('--undo')))) return undefined;
  const data: ReturnType<typeof outputPrData> = command.outputEvidence ? outputPrData(output) : { urls: [] };
  if (data.invalid) return undefined;
  const create = command.action === 'create' || command.action === 'create-api';
  let candidates = data.urls;
  if (create && !command.outputEvidence) return undefined;
  if (create && command.action === 'create') {
    // gh create prints the new URL last, after warnings, not in body/title text.
    const last = canonicalPrUrl(output.split(/\r?\n/).pop()!.trim());
    candidates = last ? [last] : [];
  }
  const explicit = command.target && canonicalPrUrl(command.target);
  const number = command.target && /^#?[1-9]\d*$/.test(command.target) ? command.target.replace(/^#/, '') : undefined;
  if (command.target && !explicit && !number && !confirmed) return undefined;
  let url: string | undefined;
  if (explicit) {
    url = explicit;
  } else if (number && command.repo) {
    url = `https://github.com/${command.repo}/pull/${number}`;
  } else if (number) {
    const matches = uniquePrUrls(candidates.length ? candidates : known).filter(candidate => String(parsePrUrl(candidate)!.number) === number);
    if (matches.length === 1) url = matches[0];
  } else if (candidates.length === 1) {
    url = candidates[0];
  }
  if (!url) return undefined;
  const identity = parsePrUrl(url)!;
  if (data.number !== undefined && data.number !== identity.number) return undefined;
  // gh's human success lines must not contradict the target, either. These
  // short references validate provenance; they never supply a missing repo.
  if (command.outputEvidence) {
    for (const line of output.split(/\r?\n/)) {
      const reference = line.match(/^\s*[✓✔!]?\s*(?:(?:Added|Merged|Squashed and merged|Rebased and merged|Closed|Reopened|Updated|Marked)\s+(?:pull request|PR)|Pull request|Auto-merge enabled for pull request)\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*)\b/i);
      if (reference && (Number(reference[2]) !== identity.number
        || (reference[1] && reference[1].toLowerCase() !== `${identity.owner}/${identity.repo}`.toLowerCase()))) return undefined;
    }
  }
  if (command.repo && `${identity.owner}/${identity.repo}`.toLowerCase() !== command.repo.toLowerCase()) return undefined;
  // Conflicting identities are not confirmation of the requested interaction.
  if (candidates.some(candidate => candidate.toLowerCase() !== url.toLowerCase())) return undefined;
  // References on other lines are not part of a success-line title. Reject
  // ambiguous multi-PR output while leaving links in that title alone.
  if (command.outputEvidence && output.split(/\r?\n/).some(line =>
    !/^[✓✔]?\s*(?:(?:Added|(?:Successfully )?Merged|Squashed and merged|Rebased and merged|Closed|Reopened|Updated|Marked)\s+(?:pull request|PR)|Pull request|Auto-merge enabled for pull request)\b/i.test(line.trim())
    && /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*\b/.test(line))) return undefined;
  // Prefer the spelling already used by the chat, not a differently cased confirmation.
  url = known.find(value => value.toLowerCase() === url!.toLowerCase()) ?? url;
  if (create) return { url, event: command.switches.has('--draft') || command.switches.has('-d') ? 'created-draft' : 'created' };
  if (confirmed) return { url, event: confirmed.event };
  let event: PrEvent;
  switch (command.action) {
    case 'merge':
      if (command.switches.has('--disable-auto')) event = 'updated';
      else if (command.outputEvidence && (data.state === 'merged' || /(?:^|\n)\s*(?:[✓✔]\s*)?(?:(?:successfully\s+)?(?:squashed and |rebased and )?merged (?:pull request|PR)\b)/i.test(output))) event = 'merged';
      else if (command.outputEvidence && /(?:^|\n)\s*(?:[✓✔]\s*)?Added\b[^\n]*\b(?:to (?:the )?)merge queue\b/i.test(output)) event = 'queued';
      else if (!output || data.urls.length || /^\s*\{/.test(output) || output.split(/\r?\n/).every(line => SILENT_MERGE_LINE_RE.test(line.trim()))) event = 'merge-requested';
      else return undefined;
      break;
    case 'ready': event = command.switches.has('--undo') ? 'draft' : 'ready'; break;
    case 'close': event = 'closed'; break;
    case 'reopen': event = 'reopened'; break;
    case 'edit': event = 'updated'; break;
    case 'review': event = 'reviewed'; break;
    default: event = 'viewed';
  }
  return { url, event };
}

/**
 * Successful, attributable CLI interactions in call order, without collapsing
 * repeated events. Numeric targets use only identities proven before the call
 * (or explicit command/result evidence), never a future call or live poller.
 */
export function collectSessionPrInteractions(messages: PrMessages, knownUrls: readonly string[] = []): Array<{ toolCallId: string; url: string; event: PrEvent }> {
  const known = new Set(uniquePrUrls(knownUrls));
  const calls = new Map<string, { command?: PrCommand; known: string[]; order: number }>();
  const seen = new Set<string>();
  const results: Array<{ toolCallId: string; url: string; event: PrEvent; order: number }> = [];
  let order = 0;
  for (const message of messages) {
    // A result must follow its call; scanning all calls up front admits orphans.
    const result = message.toolResult;
    if (result?.toolCallId) {
      const call = calls.get(result.toolCallId);
      calls.delete(result.toolCallId);
      if (call?.command && !result.isError && typeof result.output === 'string') {
        const interaction = interactionFor(call.command, result.output.replace(/\x1b\[[0-9;]*m/g, '').trim(), call.known);
        if (interaction) {
          known.add(interaction.url);
          results.push({ toolCallId: result.toolCallId, ...interaction, order: call.order });
        }
      }
    }
    for (const call of message.toolCalls ?? []) {
      if (seen.has(call.id)) {
        calls.delete(call.id);
        continue;
      }
      seen.add(call.id);
      if ((call.name !== 'bash' && call.name !== 'Bash') || typeof call.input?.command !== 'string') continue;
      const words = prCommandWords(call.input.command);
      calls.set(call.id, { command: words ? parsePrCommand(words) : undefined, known: [...known], order: order++ });
    }
  }
  return results.sort((a, b) => a.order - b.order).map(({ order: _order, ...interaction }) => interaction);
}

/** Only successful PR-creation tool results attach PRs to this chat. */
export function collectSessionPrUrls(messages: Array<{
  role?: string; content?: string;
  toolCalls?: Array<{ id: string; name: string; input?: Record<string, unknown> }>;
  toolResult?: { toolCallId?: string; output?: string; isError?: boolean };
}>): string[] {
  const calls = new Map(messages.flatMap(m => (m.toolCalls ?? []).map(c => [c.id, c] as const)));
  const urls = new Set<string>();
  for (const m of messages) {
    const result = m.toolResult;
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
    const create = /^gh\s+pr\s+create(?:\s|$)/.test(command);
    const api = /^gh\s+api\s+(?:repos\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls(?:\s|$)/.test(command)
      && /(?:-X|--method)\s+POST\b/.test(command);
    if (!create && !api) continue;
    // `gh pr create` prints the PR's URL last, after any warnings (with `2>&1`).
    const output = (result?.output ?? '').trim();
    const value = create ? output.split(/\r?\n/).pop()!.trim() : output;
    if (/^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(value)) urls.add(value);
  }
  return [...urls];
}

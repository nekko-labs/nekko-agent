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
    if (!call || result?.isError || call.name !== 'bash') continue;
    const command = String(call.input?.command ?? '').trim();
    // Do not classify strings embedded in scripts, quoted fixtures, or shell
    // batches as creation. Fail closed when output provenance is ambiguous.
    if (!command.startsWith('gh ') || /[\r\n;&|`]/.test(command)) continue;
    const create = /^gh\s+pr\s+create(?:\s|$)/.test(command);
    const api = /^gh\s+api\s+(?:repos\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls(?:\s|$)/.test(command)
      && /(?:-X|--method)\s+POST\b/.test(command);
    if (!create && !api) continue;
    const value = (result?.output ?? '').trim();
    if (/^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(value)) urls.add(value);
  }
  return [...urls];
}

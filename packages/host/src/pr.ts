import { execFile } from 'child_process';
import { PrReadCache, PrReadQueue, githubReadCooldownMs } from './pr-cache.js';
import type { PrAction, PrActionResult, PrChecks, PrDiff, PrDiffFile, PrInfo, PrState } from '@nekko-agent/shared';
import { collectSessionPrUrls, parsePrUrl } from '@nekko-agent/shared';
import { getSettings } from './store.js';
import { getSession } from './sessions.js';

/**
 * Pull-request state for the in-chat PR card, diff pane, and per-chat badges.
 *
 * A chat "has" a PR when a GitHub PR URL appears in its transcript; we hydrate
 * live state via the `gh` CLI and fall back to the GitHub REST API (with the
 * GitHub connector's PAT) when `gh` isn't installed or authenticated. Actions
 * (approve / decline / merge) are always user-initiated from the card.
 */

/** Run a binary, resolving its success + captured output (never rejects). */
function run(
  bin: string,
  args: string[],
  timeoutMs = 15_000,
  cwd?: string,
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const missing = !!e && (e.code === 'ENOENT' || (e as NodeJS.ErrnoException).errno === -4058);
      resolve({
        ok: !err,
        code: typeof e?.code === 'number' ? e.code : err ? 1 : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        missing,
      });
    });
  });
}

const ghReadQueue = new PrReadQueue();

async function runGhRead(args: string[], timeoutMs?: number, cwd?: string) {
  return ghReadQueue.run(async () => {
    if (Date.now() < ghReadCooldownUntil) return { ok: false, code: 1, stdout: '', stderr: 'GitHub background reads paused after rate limit', missing: false };
    const result = await run('gh', args, timeoutMs, cwd);
    ghReadCooldownUntil = Math.max(ghReadCooldownUntil, Date.now() + githubReadCooldownMs(result.stderr));
    return result;
  });
}

let ghReadCooldownUntil = 0;
let ghMissing = false; // sticky once we learn gh isn't installed (avoids re-probing)

/** The GitHub token for API fallback: the connector's PAT, else the environment. */
function githubToken(): string | undefined {
  const conn = getSettings().connectors?.find((c) => c.kind === 'github' && c.connected && c.token);
  return conn?.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

function apiHeaders(): Record<string, string> {
  const token = githubToken();
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nekko-agent',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Roll up gh's statusCheckRollup array into a single status. */
export function rollupChecks(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup as Array<Record<string, string>>) {
    const conclusion = (c.conclusion || '').toUpperCase();
    const status = (c.status || '').toUpperCase();
    const state = (c.state || '').toUpperCase();
    if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'ERROR'].includes(conclusion) || ['FAILURE', 'ERROR'].includes(state)) {
      return 'failing';
    }
    if ((status && status !== 'COMPLETED') || state === 'PENDING' || state === 'EXPECTED') pending = true;
  }
  return pending ? 'pending' : 'passing';
}

export function ghState(state: string, mergedAt?: string | null): PrState {
  const s = (state || '').toUpperCase();
  if (s === 'MERGED' || mergedAt) return 'merged';
  if (s === 'CLOSED') return 'closed';
  return 'open';
}

const GH_FIELDS =
  'number,title,state,url,isDraft,createdAt,closedAt,mergedAt,additions,deletions,changedFiles,headRefName,baseRefName,reviewDecision,statusCheckRollup,updatedAt';

/**
 * A PR as `gh pr view --json` describes it. `lifecycle` adds `createdAt` and
 * `closedAt`, which the by-URL read reports and the branch read does not.
 * Pure, so the engine daemon's port (crates/nekko-workspace pr.rs) is held to it.
 */
export function prInfoFromGh(url: string, parsed: { owner: string; repo: string; number: number }, j: Record<string, unknown>, lifecycle: boolean): PrInfo {
  const { owner, repo, number } = parsed;
  return {
    url,
    owner,
    repo,
    number,
    title: String(j.title ?? (lifecycle ? `${owner}/${repo}#${number}` : `#${number}`)),
    state: ghState(String(j.state ?? 'OPEN'), j.mergedAt as string | null),
    isDraft: !!j.isDraft,
    additions: Number(j.additions ?? 0),
    deletions: Number(j.deletions ?? 0),
    changedFiles: Number(j.changedFiles ?? 0),
    headRefName: (j.headRefName as string) || undefined,
    baseRefName: (j.baseRefName as string) || undefined,
    reviewDecision: (j.reviewDecision as string) || null,
    checks: rollupChecks(j.statusCheckRollup),
    ...(lifecycle ? { createdAt: (j.createdAt as string) || null, closedAt: (j.closedAt as string) || null } : {}),
    mergedAt: (j.mergedAt as string) || null,
    updatedAt: (j.updatedAt as string) || null,
    source: 'gh',
  };
}

/** The combined commit status as one rollup (the REST fallback's checks). */
export function checksFromStatus(cj: { state?: string; total_count?: number }): PrChecks {
  const st = (cj.state || '').toLowerCase();
  return st === 'success' ? 'passing' : st === 'failure' || st === 'error' ? 'failing' : (cj.total_count ?? 0) > 0 ? 'pending' : 'none';
}

/** A PR as the REST API's pull endpoint describes it. */
export function prInfoFromApi(url: string, parsed: { owner: string; repo: string; number: number }, j: Record<string, any>, checks: PrChecks): PrInfo {
  const { owner, repo, number } = parsed;
  return {
    url,
    owner,
    repo,
    number,
    title: String(j.title ?? `${owner}/${repo}#${number}`),
    state: j.merged ? 'merged' : j.state === 'open' ? 'open' : 'closed',
    isDraft: !!j.draft,
    additions: Number(j.additions ?? 0),
    deletions: Number(j.deletions ?? 0),
    changedFiles: Number(j.changed_files ?? 0),
    headRefName: j.head?.ref || undefined,
    baseRefName: j.base?.ref || undefined,
    reviewDecision: null,
    checks,
    createdAt: j.created_at || null,
    closedAt: j.closed_at || null,
    mergedAt: j.merged_at || null,
    updatedAt: j.updated_at || null,
    source: 'api',
  };
}

/** One file of the REST API's PR files listing, as the diff pane shows it. */
export function diffFileFromApi(f: Record<string, any>): PrDiffFile {
  return {
    path: String(f.filename),
    oldPath: f.previous_filename || undefined,
    status: f.status === 'added' ? 'added' : f.status === 'removed' ? 'removed' : f.status === 'renamed' ? 'renamed' : 'modified',
    additions: Number(f.additions ?? 0),
    deletions: Number(f.deletions ?? 0),
    patch: typeof f.patch === 'string' ? f.patch : '',
  };
}

/** Fetch one PR's live state via gh, falling back to the REST API. */
export async function fetchPrInfo(url: string): Promise<PrInfo | null> {
  const parsed = parsePrUrl(url);
  if (!parsed) return null;
  const { owner, repo, number } = parsed;
  const slug = `${owner}/${repo}`;

  // Preferred path: gh CLI.
  if (!ghMissing && Date.now() >= ghReadCooldownUntil) {
    const res = await runGhRead(['pr', 'view', String(number), '--repo', slug, '--json', GH_FIELDS]);
    ghReadCooldownUntil = Math.max(ghReadCooldownUntil, Date.now() + githubReadCooldownMs(res.stderr));
    if (res.missing) {
      ghMissing = true;
    } else if (res.ok) {
      try {
        return prInfoFromGh(url, { owner, repo, number }, JSON.parse(res.stdout) as Record<string, unknown>, true);
      } catch {
        /* fall through to API */
      }
    }
    // gh present but errored (not authed / no access): fall through to the API.
  }

  return fetchPrInfoApi(owner, repo, number, url);
}

async function fetchPrInfoApi(owner: string, repo: string, number: number, url: string): Promise<PrInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, { headers: apiHeaders() });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, any>;
    let checks: PrChecks = 'none';
    const sha = j.head?.sha as string | undefined;
    if (sha) {
      try {
        const cs = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`, { headers: apiHeaders() });
        if (cs.ok) checks = checksFromStatus((await cs.json()) as { state?: string; total_count?: number });
      } catch { /* checks are best-effort */ }
    }
    return prInfoFromApi(url, { owner, repo, number }, j, checks);
  } catch {
    return null;
  }
}

// Share reads across cards, sessions and concurrent refreshes.
const cache = new PrReadCache<PrInfo | null>(60_000);

async function cachedInfo(url: string, force = false): Promise<PrInfo | null> {
  return cache.get(url, () => fetchPrInfo(url), force);
}

// A branch's PR changes rarely (opened once, merged once) and asking costs a gh
// round trip, so it is cached for a minute per folder + branch, and a branch
// with no PR is remembered as such rather than asked about on every poll.
const BRANCH_PR_TTL = 60_000;
const branchCache = new Map<string, { info: PrInfo | null; ts: number }>();
const branchInFlight = new Map<string, Promise<PrInfo | null>>();

/**
 * The pull request for the branch checked out in `cwd`, via `gh pr view`.
 *
 * gh resolves a branch's PR itself (including one opened from a fork), which is
 * why this asks gh rather than the REST API: there is no URL to start from. No
 * gh, no auth, and no PR all come back as null.
 */
export async function branchPr(cwd: string, branch: string): Promise<PrInfo | null> {
  if (ghMissing) return null;
  const key = `${cwd}|${branch}`;
  const hit = branchCache.get(key);
  if (hit && Date.now() - hit.ts < BRANCH_PR_TTL) return hit.info;
  if (Date.now() < ghReadCooldownUntil) return hit?.info ?? null;
  const pending = branchInFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const res = await runGhRead(['pr', 'view', branch, '--json', GH_FIELDS], 10_000, cwd);
    ghReadCooldownUntil = Math.max(ghReadCooldownUntil, Date.now() + githubReadCooldownMs(res.stderr));
    if (res.missing) ghMissing = true;
    let info: PrInfo | null = null;
    if (res.ok) {
      try {
        const j = JSON.parse(res.stdout) as Record<string, unknown>;
        const url = String(j.url ?? '');
        const parsed = parsePrUrl(url);
        if (parsed) info = prInfoFromGh(url, parsed, j, false);
      } catch {
        /* unparseable output: treat as no PR */
      }
    }
    branchCache.set(key, { info, ts: Date.now() });
    return info;
  })().finally(() => branchInFlight.delete(key));
  branchInFlight.set(key, promise);
  return promise;
}

/** Live PR state for every PR URL referenced in a session's transcript. */
export async function listSessionPrs(sessionId: string): Promise<PrInfo[]> {
  const session = getSession(sessionId);
  if (!session) return [];
  const urls = collectSessionPrUrls(session.messages);
  if (urls.length === 0) return [];
  const infos = await Promise.all(urls.map((u) => cachedInfo(u)));
  return infos.filter((i): i is PrInfo => !!i);
}

// --- Diff ---

/** Split a unified diff into per-file entries (for the gh path). */
export function parseUnifiedDiff(text: string): PrDiffFile[] {
  const files: PrDiffFile[] = [];
  const blocks = text.split(/^diff --git .*$/m).slice(1);
  const headers = [...text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  blocks.forEach((block, i) => {
    const header = headers[i];
    let path = header?.[2] ?? 'file';
    let oldPath: string | undefined;
    let status: PrDiffFile['status'] = 'modified';
    if (/^new file mode/m.test(block)) status = 'added';
    else if (/^deleted file mode/m.test(block)) status = 'removed';
    const renameFrom = block.match(/^rename from (.+)$/m);
    const renameTo = block.match(/^rename to (.+)$/m);
    if (renameFrom && renameTo) { status = 'renamed'; oldPath = renameFrom[1]; path = renameTo[1]; }
    let additions = 0;
    let deletions = 0;
    const lines = block.split('\n');
    const hunkStart = lines.findIndex((l) => l.startsWith('@@'));
    for (const l of lines) {
      if (l.startsWith('+') && !l.startsWith('+++')) additions++;
      else if (l.startsWith('-') && !l.startsWith('---')) deletions++;
    }
    const patch = hunkStart >= 0 ? lines.slice(hunkStart).join('\n') : '';
    files.push({ path, oldPath, status, additions, deletions, patch });
  });
  return files;
}

const MAX_DIFF_FILES = 80;

/** The PR's changed files + patches, for the diff pane. */
export async function getPrDiff(url: string): Promise<PrDiff> {
  const parsed = parsePrUrl(url);
  if (!parsed) return { url, files: [] };
  const { owner, repo, number } = parsed;
  const slug = `${owner}/${repo}`;

  if (!ghMissing) {
    const res = await run('gh', ['pr', 'diff', String(number), '--repo', slug], 20_000);
    if (res.missing) ghMissing = true;
    else if (res.ok) {
      const files = parseUnifiedDiff(res.stdout);
      return { url, files: files.slice(0, MAX_DIFF_FILES), truncated: files.length > MAX_DIFF_FILES };
    }
  }

  // API fallback: the files endpoint returns per-file patches directly.
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, { headers: apiHeaders() });
    if (!res.ok) return { url, files: [] };
    const arr = (await res.json()) as Array<Record<string, any>>;
    const files: PrDiffFile[] = arr.slice(0, MAX_DIFF_FILES).map(diffFileFromApi);
    return { url, files, truncated: arr.length > MAX_DIFF_FILES };
  } catch {
    return { url, files: [] };
  }
}

// --- Actions (user-initiated) ---

async function apiAction(owner: string, repo: string, number: number, action: PrAction): Promise<{ ok: boolean; message: string }> {
  if (!githubToken()) return { ok: false, message: 'No gh CLI and no GitHub token configured. Connect GitHub in Connectors, or install and sign in to the gh CLI.' };
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    if (action === 'approve') {
      const r = await fetch(`${base}/pulls/${number}/reviews`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ event: 'APPROVE' }) });
      return { ok: r.ok, message: r.ok ? 'Approved.' : `Approve failed (${r.status}).` };
    }
    if (action === 'merge') {
      const r = await fetch(`${base}/pulls/${number}/merge`, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ merge_method: 'merge' }) });
      return { ok: r.ok, message: r.ok ? 'Merged.' : `Merge failed (${r.status}).` };
    }
    // close / reopen
    const r = await fetch(`${base}/pulls/${number}`, { method: 'PATCH', headers: apiHeaders(), body: JSON.stringify({ state: action === 'reopen' ? 'open' : 'closed' }) });
    return { ok: r.ok, message: r.ok ? (action === 'reopen' ? 'Reopened.' : 'Closed.') : `${action} failed (${r.status}).` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Perform a PR action (approve / decline / merge / reopen). User-initiated. */
export async function prAction(url: string, action: PrAction): Promise<PrActionResult> {
  const parsed = parsePrUrl(url);
  if (!parsed) return { ok: false, message: 'Not a valid PR URL.' };
  const { owner, repo, number } = parsed;
  const slug = `${owner}/${repo}`;

  let result: { ok: boolean; message: string };
  if (!ghMissing) {
    const argsByAction: Record<PrAction, string[]> = {
      approve: ['pr', 'review', String(number), '--repo', slug, '--approve'],
      close: ['pr', 'close', String(number), '--repo', slug],
      reopen: ['pr', 'reopen', String(number), '--repo', slug],
      merge: ['pr', 'merge', String(number), '--repo', slug, '--merge'],
    };
    const res = await run('gh', argsByAction[action], 30_000);
    if (res.missing) { ghMissing = true; result = await apiAction(owner, repo, number, action); }
    else if (res.ok) result = { ok: true, message: `${action[0].toUpperCase()}${action.slice(1)} succeeded.` };
    else result = { ok: false, message: (res.stderr || res.stdout || `gh ${action} failed`).trim().split('\n')[0].slice(0, 240) };
  } else {
    result = await apiAction(owner, repo, number, action);
  }

  cache.delete(url);
  const pr = result.ok ? (await cachedInfo(url, true)) ?? undefined : undefined;
  return { ...result, pr };
}

#!/usr/bin/env node
/**
 * Queue repair: un-sticks ready PRs that native auto-merge cannot land by
 * itself. (The name predates 2026-11-06, when the merge queue was removed.)
 *
 * auto-merge.yml arms auto-merge and queue-sweeper.yml re-arms a missing request
 * and re-runs a flaky `gate` once. Two cases still sat with nobody watching,
 * because the agent session that opened the PR had often ended:
 *
 *   - the PR conflicts with main (usually on a file every PR appends to), and
 *   - `gate` stays red after the sweeper's re-run.
 *
 * For each ready, same-repo PR into main, this:
 *
 *   1. merges main into the branch on the runner. Conflicts only in files with a
 *      known rule (RULES below) are resolved mechanically and the merge is pushed
 *      with the repo's App token, so CI runs and auto-merge lands it once green;
 *   2. when every job that failed also fails in other PRs' CI runs (a
 *      suspected shared baseline failure), asks nobody: Codex
 *      cannot fix main from a PR branch. It says so once, waits, and retries the
 *      PR against newer main, or re-runs it once the signal clears when main is
 *      already included (at most RETRY_BUDGET re-runs per head);
 *   3. otherwise asks Codex: a `@codex` comment posted with CODEX_TOKEN (a token
 *      of a maintainer whose ChatGPT account has Codex connected to GitHub) starts
 *      a Codex cloud task on the PR, which pushes its fix to the branch. Once per
 *      head commit and kind, at most CODEX_BUDGET times per PR;
 *   4. when Codex is not set up, did not push within CODEX_WAIT_MS, or the budget
 *      is spent, labels the PR `needs-human` and says why. A new push clears it.
 *
 *   node scripts/queue-repair.mjs              # every eligible PR
 *   PR=123 node scripts/queue-repair.mjs       # one PR
 *   node scripts/queue-repair.mjs --dry-run    # decide and merge locally, push and comment nothing
 *
 * Env: GITHUB_REPOSITORY, GH_TOKEN (comments, labels, reads), PUSH_TOKEN (App
 * token, pushes), APP_SLUG (the App's slug, for the commit author), CODEX_TOKEN
 * (optional). The merge runs in a throwaway worktree, never in this checkout,
 * so the script that runs is always main's.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIndex } from './spec-index.mjs';

export const CODEX_WAIT_MS = 60 * 60 * 1000;
export const CODEX_BUDGET = 3;
export const NEEDS_HUMAN = 'needs-human';
/** Retries of one head after a baseline failure on main has cleared. */
export const RETRY_BUDGET = 2;
/** How far back other PRs' CI runs count as shared-failure evidence. */
export const BASELINE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** A job failing in this many other PRs' CI runs may be a shared baseline failure. */
export const BASELINE_MIN_PRS = 2;

/**
 * Suspected shared job failures: those that failed in the latest CI runs of at
 * least BASELINE_MIN_PRS other PRs within BASELINE_WINDOW_MS.
 *   runs: [{ pr, at, failed: [jobName] }]
 */
export function baselineJobs(runs, number, now = Date.now(), branch) {
  // Newer green runs supersede old failures from the same PR. Pending and
  // cancelled runs are filtered by the caller: neither proves recovery.
  const latest = new Map();
  for (const r of runs) {
    if (!latest.has(r.pr) || r.at > latest.get(r.pr).at) latest.set(r.pr, r);
  }
  const prsByJob = new Map();
  for (const r of latest.values()) {
    if (r.pr === number || (branch && r.branch === branch) || now - r.at > BASELINE_WINDOW_MS) continue;
    for (const job of r.failed) {
      if (job === 'gate') continue;
      if (!prsByJob.has(job)) prsByJob.set(job, new Set());
      prsByJob.get(job).add(r.pr);
    }
  }
  return new Set([...prsByJob].filter(([, prs]) => prs.size >= BASELINE_MIN_PRS).map(([job]) => job));
}

/** True when every failed job has the shared-failure signal (not causal proof). */
export const onlyBaseline = (jobs, baseline) => jobs.length > 0 && jobs.every((j) => baseline.has(j.name));
const RED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED']);

/**
 * How a conflict in a given file is resolved without judgment, or null when it
 * needs one. `mainHasTaskLog`: main's TASKS.md still carries Part 2's task log
 * (before the move to GitHub issues), where both sides' new entries belong.
 */
export function ruleFor(file, { mainHasTaskLog = false } = {}) {
  switch (file) {
    case 'spec/README.md':
      return 'take-main-and-reindex';
    case 'apps/website/llms.txt':
    case 'apps/website/sitemap.xml':
      // docs-site.yml regenerates both on the PR when nav.json says they are stale.
      return 'take-main';
    case 'docs/perf-history.md':
      return 'union';
    case 'TASKS.md':
      return mainHasTaskLog ? 'union' : 'take-main-keep-additions';
    default:
      return null;
  }
}

/** Every `<!-- queue-repair:kind:sha -->` (and the sweeper's) marker in the comments. */
export function readMarkers(comments) {
  const out = [];
  for (const c of comments) {
    for (const m of (c.body ?? '').matchAll(/<!-- (queue-repair|queue-sweeper):([\w-]+):([0-9a-f]{7,40}) -->/g)) {
      out.push({ kind: m[1] === 'queue-sweeper' ? `sweeper-${m[2]}` : m[2], sha: m[3], at: Date.parse(c.createdAt) });
    }
  }
  return out;
}

export const marker = (kind, sha) => `<!-- queue-repair:${kind}:${sha} -->`;

/**
 * What to do with one PR. Pure: everything it needs is in `pr`.
 *   pr: { draft, crossRepo, labels[], mergeable, head, gate, gateAttempt, markers[] }
 * Returns { action: 'skip' | 'merge' | 'codex' | 'needs-human', kind?, why }.
 */
export function decide(pr, now = Date.now()) {
  if (pr.draft) return { action: 'skip', why: 'draft' };
  if (pr.crossRepo) return { action: 'skip', why: 'from a fork; nothing is pushed to forks' };
  if (pr.labels.includes('hold')) return { action: 'skip', why: 'labelled hold' };

  const here = pr.markers.filter((m) => m.sha === pr.head);
  if (here.some((m) => m.kind === NEEDS_HUMAN)) return { action: 'skip', why: 'waiting for a person at this head' };

  const asked = here.find((m) => m.kind.startsWith('codex-'));
  if (asked) {
    if (now - asked.at < CODEX_WAIT_MS) return { action: 'skip', why: 'waiting for Codex' };
    return { action: 'needs-human', why: `Codex was asked (${asked.kind.slice(6)}) over an hour ago and pushed nothing` };
  }

  const waiting = here.find((m) => m.kind === 'baseline-ci');
  if (waiting && RED.has(pr.gate) && pr.gateAttempt > 0 && pr.mergeable !== 'CONFLICTING') {
    return { action: 'baseline', kind: waiting.kind.slice(9), retries: here.filter((m) => m.kind === 'retried').length };
  }

  // UNKNOWN is GitHub not having computed it yet: merge locally to find out, and
  // when that is clean, decide again as MERGEABLE (main() does).
  if (pr.mergeable === 'CONFLICTING' || pr.mergeable === 'UNKNOWN') return { action: 'merge', why: `mergeable is ${pr.mergeable}` };

  if (RED.has(pr.gate) && pr.gateAttempt >= 2) return codexOrHuman(pr, 'ci', `gate is ${pr.gate} after the sweeper's re-run`);
  return { action: 'skip', why: `gate is ${pr.gate || 'pending'}` };
}

/** Codex, unless the PR already used up its budget. Also used after an unresolvable merge. */
export function codexOrHuman(pr, kind, why) {
  const spent = new Set(pr.markers.filter((m) => m.kind.startsWith('codex-')).map((m) => `${m.kind}:${m.sha}`)).size;
  if (spent >= CODEX_BUDGET) return { action: 'needs-human', why: `${why}, and Codex has already been asked ${spent} times on this PR` };
  return { action: 'codex', kind, why };
}

/** The `@codex` request for one kind of failure. */
export function codexPrompt(kind, { branch, head, files = [], jobs = [] }) {
  const rules = [
    'Never weaken a test, a budget or a check to get past it.',
    'Write commit messages as the author would: no AI attribution, no Co-Authored-By trailer, no generated-by footer.',
    `Push to this PR's branch (\`${branch}\`); do not open a new PR.`,
  ];
  const jobList = jobs.map((j) => `- [${j.name}](${j.url})`).join('\n');
  if (kind === 'conflict') {
    return [
      `@codex Merge \`main\` into this branch and resolve the merge conflicts in:`,
      files.map((f) => `- \`${f}\``).join('\n'),
      '',
      'Keep the intent of both sides: main has already landed, so keep its changes, and re-apply this PR on top of them. If a conflict needs a product decision, stop and say which one instead of guessing. Then run the checks that cover the files you touched.',
      ...rules,
    ].join('\n');
  }
  return [
    `@codex \`gate\` is red at ${head.slice(0, 8)} after a re-run; these jobs failed:`,
    jobList || '- (no failed job found; read the latest run)',
    '',
    'Find the cause in the logs and fix it on this branch. If `main` fails the same way, do not work around it here: reply saying so.',
    ...rules,
  ].join('\n');
}

/* ---------------------------------------------------------------- git side */

function git(args, { cwd, allowFail = false, input } = {}) {
  try {
    return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')}: ${e.stderr || e.message}`);
  }
}

/** Union-merge attributes for the runner's own merges, whatever the PR's .gitattributes says. */
export function ensureUnionAttributes(repo) {
  const file = path.join(path.resolve(repo, git(['rev-parse', '--git-common-dir'], { cwd: repo })), 'info', 'attributes');
  const lines = ['docs/perf-history.md merge=union'];
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = lines.filter((l) => !have.split('\n').includes(l));
  if (missing.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }
}

/** One side of a conflicted file, byte for byte (git() trims, which would eat the final newline). */
function stage(cwd, n, file) {
  const r = spawnSync('git', ['show', `:${n}:${file}`], { cwd, maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : Buffer.alloc(0);
}

/**
 * Re-merge one conflicted file from its index stages (2 = the PR, 1 = base,
 * 3 = main), settling conflicting hunks by `mode` (--union keeps both sides,
 * --theirs keeps main's). `dropped` is the PR's side of every conflicting hunk.
 */
function mergeFile(cwd, file, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-repair-'));
  try {
    const [o, b, t] = ['pr', 'base', 'main'].map((n, i) => {
      const p = path.join(dir, n);
      fs.writeFileSync(p, stage(cwd, [2, 1, 3][i], file));
      return p;
    });
    const run = (extra) => spawnSync('git', ['merge-file', '-p', ...extra, o, b, t], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
    // With --diff3 each clash shows the PR's side, then base's. A line the PR
    // side shares with base is old text main removed, not something the PR wrote.
    const dropped = [];
    let side = null;
    let pr = [];
    let base = [];
    for (const line of run(['--diff3']).split('\n')) {
      if (line.startsWith('<<<<<<< ')) [side, pr, base] = ['pr', [], []];
      else if (side && line.startsWith('||||||| ')) side = 'base';
      else if (side && line === '=======') side = 'main';
      else if (side && line.startsWith('>>>>>>> ')) {
        const old = new Set(base);
        dropped.push(...pr.filter((l) => !old.has(l)));
        side = null;
      } else if (side === 'pr') pr.push(line);
      else if (side === 'base') base.push(line);
    }
    return { text: run([mode]), dropped };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function takeMain(cwd, mainRef, file) {
  if (git(['cat-file', '-e', `${mainRef}:${file}`], { cwd, allowFail: true }) === null) git(['rm', '-q', '--', file], { cwd });
  else git(['checkout', mainRef, '--', file], { cwd });
}

/**
 * Merge `mainRef` into `head` in a new worktree at `workdir`. Returns
 *   { status: 'up-to-date' | 'clean' | 'resolved' | 'unresolved', resolved: [{file, rule}],
 *     unresolved: [file], additions: {file: [line]}, sha }
 * A 'clean' or 'resolved' merge is committed in the worktree; an unresolved one is aborted.
 */
export function mergeMain({ repo, head, mainRef = 'origin/main', workdir, branch, author }) {
  ensureUnionAttributes(repo);
  if (git(['merge-base', '--is-ancestor', mainRef, head], { cwd: repo, allowFail: true }) !== null) {
    return { status: 'up-to-date', resolved: [], unresolved: [], additions: {} };
  }
  git(['worktree', 'add', '-q', '--detach', workdir, head], { cwd: repo });
  const cwd = workdir;
  // Per command, never `git config`: a worktree's config is the repository's,
  // so that would change the identity of every checkout of it.
  const as = author ? ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`] : [];
  const message = `Merge main into ${branch}`;
  if (git([...as, 'merge', '--no-ff', '--no-edit', '-m', message, mainRef], { cwd, allowFail: true }) !== null) {
    return { status: 'clean', resolved: [], unresolved: [], additions: {}, sha: git(['rev-parse', 'HEAD'], { cwd }) };
  }

  const conflicted = (git(['diff', '--name-only', '--diff-filter=U'], { cwd }) || '').split('\n').filter(Boolean);
  const mainTasks = git(['show', `${mainRef}:TASKS.md`], { cwd, allowFail: true }) ?? '';
  const ctx = { mainHasTaskLog: /^## Part 2\b/m.test(mainTasks) };
  const unresolved = conflicted.filter((f) => !ruleFor(f, ctx));
  if (unresolved.length) {
    git(['merge', '--abort'], { cwd });
    return { status: 'unresolved', resolved: [], unresolved, additions: {} };
  }

  const resolved = [];
  const additions = {};
  for (const file of conflicted) {
    const rule = ruleFor(file, ctx);
    if (rule === 'union' || rule === 'take-main-keep-additions') {
      // Only the conflicting hunks are decided here; the rest of the PR's edits
      // to the file (say, a real Part 1 plan change) merge as usual.
      const r = mergeFile(cwd, file, rule === 'union' ? '--union' : '--theirs');
      fs.writeFileSync(path.join(cwd, file), r.text);
      if (rule === 'take-main-keep-additions') additions[file] = r.dropped;
      git(['add', '--', file], { cwd });
    } else {
      takeMain(cwd, mainRef, file);
      if (rule === 'take-main-and-reindex' && fs.existsSync(path.join(cwd, file)) && fs.readFileSync(path.join(cwd, file), 'utf8').includes('<!-- index:start -->')) {
        // Before the index stopped being committed: rebuild it from both sides' spec files.
        // main's index code, run here: nothing from the PR branch runs on this runner,
        // which holds the App token and a maintainer's Codex token.
        writeIndex(cwd);
        git(['add', '--', file], { cwd });
      }
    }
    resolved.push({ file, rule });
  }
  git([...as, 'commit', '-q', '--no-edit'], { cwd });
  return { status: 'resolved', resolved, unresolved: [], additions, sha: git(['rev-parse', 'HEAD'], { cwd }) };
}

/* ------------------------------------------------------------- GitHub side */

const env = process.env;
const REPO = env.GITHUB_REPOSITORY || 'nekko-labs/nekko-agent';

function gh(args, { token = env.GH_TOKEN, input, allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, GH_TOKEN: token, GH_REPO: REPO }, maxBuffer: 64 << 20 }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${e.stderr || e.message}`);
  }
}

function openPrs() {
  const [owner, name] = REPO.split('/');
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,baseRefName:"main",first:100){nodes{
      id number isDraft isCrossRepository headRefName headRefOid mergeable author{login}
      labels(first:20){nodes{name}}
      comments(last:100){nodes{body createdAt}}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
        ... on CheckRun{name conclusion checkSuite{workflowRun{databaseId}}}
      }}}}}}
    }}}}`;
  const data = JSON.parse(gh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `query=${query}`]));
  return data.data.repository.pullRequests.nodes.map((n) => {
    const gate = (n.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter((c) => c.name === 'gate').at(-1);
    return {
      id: n.id,
      number: n.number,
      draft: n.isDraft,
      crossRepo: n.isCrossRepository,
      branch: n.headRefName,
      head: n.headRefOid,
      author: n.author?.login,
      mergeable: n.mergeable,
      labels: n.labels.nodes.map((l) => l.name),
      markers: readMarkers(n.comments.nodes),
      gate: gate?.conclusion ?? '',
      gateRun: gate?.checkSuite?.workflowRun?.databaseId ?? null,
      gateAttempt: 0,
    };
  });
}

/** The gate run's attempt, when it is for this head and finished; 0 otherwise. */
function gateAttempt(pr) {
  if (!pr.gateRun || !RED.has(pr.gate)) return 0;
  const run = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${pr.gateRun}`]));
  return run.head_sha === pr.head && run.status === 'completed' ? run.run_attempt : 0;
}

function failedJobs(runId, attempt) {
  const path = attempt ? `repos/${REPO}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100` : `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`;
  const jobs = JSON.parse(gh(['api', path])).jobs ?? [];
  return jobs.filter((j) => ['failure', 'timed_out', 'cancelled'].includes(j.conclusion) && j.name !== 'gate').map((j) => ({ name: j.name, url: j.html_url }));
}

/** Latest conclusive CI run per PR; an in-flight/cancelled run cannot clear red. */
export function latestCiRuns(runs, now = Date.now()) {
  const latest = new Map();
  for (const r of runs) {
    const number = r.pull_requests?.[0]?.number;
    // GitHub often empties pull_requests after a PR merges. Keep its green
    // evidence under the repository + branch identity instead of losing it.
    const key = r.head_branch ? `${r.head_repository?.full_name ?? REPO}:${r.head_branch}` : number;
    if (!key || r.name !== 'CI' || r.status !== 'completed' ||
        !['success', 'failure'].includes(r.conclusion) || now - Date.parse(r.created_at) > BASELINE_WINDOW_MS) continue;
    const previous = latest.get(key);
    if (!previous || Date.parse(r.created_at) > Date.parse(previous.created_at)) latest.set(key, r);
  }
  return [...latest.values()];
}

/** Other PRs' recent CI evidence. Shared job names are a hint, not proof of main. */
let recentCiFailures = null;
function ciFailures(now) {
  if (recentCiFailures) return recentCiFailures;
  const runs = JSON.parse(gh(['api', `repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&per_page=100`])).workflow_runs ?? [];
  recentCiFailures = latestCiRuns(runs, now).map((r) => ({
    pr: r.pull_requests?.[0]?.number ?? `${r.head_repository?.full_name ?? REPO}:${r.head_branch}`,
    branch: r.head_branch, at: Date.parse(r.created_at),
    failed: r.conclusion === 'failure' ? failedJobs(r.id).map((j) => j.name) : [],
  }));
  return recentCiFailures;
}

/** The jobs behind a red `gate`. */
const jobsFor = (pr) => (pr.gateRun ? failedJobs(pr.gateRun, pr.gateAttempt) : []);

/**
 * An Actions re-run keeps the original PR merge snapshot. Incorporate newer main
 * with GitHub's ordinary merge (no force push, no code conflict resolution), then
 * let synchronize start fresh CI. The expected head rejects concurrent pushes.
 * Reads use GH_TOKEN; updates use the App token so they actually trigger CI.
 */
export function retryBaseline(pr, { stillFailing, dryRun, request = gh, pushToken = env.PUSH_TOKEN } = {}) {
  const status = request(['api', `repos/${REPO}/compare/${pr.head}...main`, '--jq', '.status']);
  if (status === 'ahead' || status === 'diverged') {
    if (!dryRun && !pushToken) throw new Error('PUSH_TOKEN is required to refresh a branch and trigger CI');
    if (!dryRun) request(['api', '--method', 'PUT', `repos/${REPO}/pulls/${pr.number}/update-branch`,
      '-f', `expected_head_sha=${pr.head}`], { token: pushToken });
    return 'refresh';
  }
  if (status !== 'identical' && status !== 'behind') throw new Error(`Unexpected main comparison: ${status}`);
  if (stillFailing) return 'wait';
  if (pr.retries >= RETRY_BUDGET) return 'exhausted';
  if (!dryRun) request(['run', 'rerun', String(pr.gateRun), '--failed']);
  return 'rerun';
}

function recoverBaseline(pr, kind, stillFailing, { dryRun, retries = 0 }) {
  let action;
  try {
    action = retryBaseline({ ...pr, retries }, { stillFailing, dryRun });
  } catch (e) {
    // No fallback to the obsolete run on conflict, a racing head or denied
    // workflow update. A person can resolve the branch; no permissions widened.
    return needsHuman(pr, `could not refresh baseline checks: ${e.message}`, { dryRun });
  }
  if (action === 'refresh') {
    console.log(`#${pr.number}: ${dryRun ? "would request" : "requested"} main refresh; waiting for new-head CI.`);
    comment(pr, `Queue repair requested a merge of current main into this branch with an expected-head check. New-head CI must pass; the old failed run was not re-run. ${marker('refreshed', pr.head)}`, { dryRun });
  } else if (action === 'rerun') {
    console.log(`#${pr.number}: already contains main; retrying unchanged snapshot.`);
    comment(pr, `Queue repair: the recent shared failure signal cleared and this branch already contains main; retrying its failed jobs. ${marker('retried', pr.head)}`, { dryRun });
  } else if (action === 'exhausted') {
    const next = codexOrHuman(pr, kind, `checks failed after ${retries} retries on a branch containing main`);
    if (next.action === 'codex') askCodex(pr, kind, { jobs: jobsFor(pr), why: next.why }, { dryRun });
    else needsHuman(pr, next.why, { dryRun });
  } else {
    console.log(`#${pr.number}: shared failures persist and main is already included; waiting.`);
  }
}

function comment(pr, body, { token, dryRun }) {
  if (dryRun) return console.log(`  [dry-run] would comment on #${pr.number}:\n${body.replace(/^/gm, '    ')}`);
  gh(['pr', 'comment', String(pr.number), '--body-file', '-'], { token, input: body });
}

function needsHuman(pr, why, { dryRun }) {
  console.log(`#${pr.number}: needs a person: ${why}`);
  if (dryRun) return;
  gh(['label', 'create', NEEDS_HUMAN, '--color', 'D93F0B', '--description', 'Queue repair could not land this; a person has to look'], { allowFail: true });
  gh(['pr', 'edit', String(pr.number), '--add-label', NEEDS_HUMAN], { allowFail: true });
  const who = pr.author && !pr.author.endsWith('[bot]') ? `@${pr.author} ` : '';
  comment(pr, `${who}Queue repair could not get this PR to merge: ${why}. Push a fix (or merge \`main\` in) and it is picked up again; the \`${NEEDS_HUMAN}\` label comes off on the next push. ${marker(NEEDS_HUMAN, pr.head)}`, { dryRun });
}

function askCodex(pr, kind, info, { dryRun }) {
  if (!env.CODEX_TOKEN) return needsHuman(pr, `${info.why}, and Codex is not set up here (no CODEX_TRIGGER_TOKEN secret)`, { dryRun });
  console.log(`#${pr.number}: asking Codex (${kind}): ${info.why}`);
  const body = `${codexPrompt(kind, { branch: pr.branch, head: pr.head, ...info })}\n\n${marker(`codex-${kind}`, pr.head)}`;
  comment(pr, body, { token: env.CODEX_TOKEN, dryRun });
}

/** Merges main in when it conflicts. Returns false when there was nothing to merge. */
function repairConflicts(pr, { dryRun, repo }) {
  git(['fetch', '-q', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main', `+refs/heads/${pr.branch}:refs/remotes/queue-repair/${pr.number}`], { cwd: repo });
  if (git(['rev-parse', `refs/remotes/queue-repair/${pr.number}`], { cwd: repo }) !== pr.head) {
    console.log(`#${pr.number}: the branch moved while this ran; next pass.`);
    return true;
  }
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `queue-repair-${pr.number}-`));
  fs.rmSync(workdir, { recursive: true, force: true });
  const slug = env.APP_SLUG ? `${env.APP_SLUG}[bot]` : 'queue-repair';
  const id = env.APP_SLUG ? gh(['api', `users/${slug}`, '--jq', '.id'], { allowFail: true }) : null;
  const author = { name: slug, email: id ? `${id}+${slug}@users.noreply.github.com` : 'queue-repair@users.noreply.github.com' };
  try {
    const r = mergeMain({ repo, head: pr.head, workdir, branch: pr.branch, author });
    // A clean merge of a PR GitHub has not marked conflicting is not worth a CI run.
    if (r.status === 'up-to-date' || (r.status === 'clean' && pr.mergeable !== 'CONFLICTING')) return false;
    if (r.status === 'unresolved') {
      const next = codexOrHuman(pr, 'conflict', `conflicts with main in ${r.unresolved.join(', ')}`);
      if (next.action === 'codex') askCodex(pr, 'conflict', { files: r.unresolved, why: next.why }, { dryRun });
      else needsHuman(pr, next.why, { dryRun });
      return true;
    }

    const how = r.resolved.map(({ file, rule }) => `- \`${file}\`: ${RULE_TEXT[rule]}`).join('\n') || '- merged cleanly (union merge on append-only files)';
    let body = `Queue repair merged \`main\` into this branch (${r.sha.slice(0, 8)}) so it can land:\n${how}`;
    for (const [file, lines] of Object.entries(r.additions)) {
      const kept = lines.filter((l) => l.trim());
      if (kept.length) body += `\n\n<details><summary>What this PR had added to \`${file}\`, which now lives in GitHub issues: move it to the linked issue</summary>\n\n\`\`\`\`markdown\n${kept.join('\n')}\n\`\`\`\`\n</details>`;
    }
    body += `\n\n${marker('merged', r.sha)}`;
    if (dryRun) {
      comment(pr, body, { dryRun });
      return true;
    }

    const url = `https://x-access-token:${env.PUSH_TOKEN}@github.com/${REPO}.git`;
    const pushed = git(['push', '-q', url, `HEAD:refs/heads/${pr.branch}`], { cwd: workdir, allowFail: true });
    if (pushed === null) {
      // Most often the branch moved (someone is on it). A merge that brings in a
      // workflow change is refused too: the App has no `workflows` permission.
      const touchesWorkflows = git(['diff', '--name-only', pr.head, 'HEAD', '--', '.github/workflows'], { cwd: workdir });
      if (touchesWorkflows) needsHuman(pr, 'the merge with main brings in workflow changes, which the repair App may not push', { dryRun });
      else console.log(`#${pr.number}: push refused (the branch probably moved); next pass.`);
      return true;
    }
    console.log(`#${pr.number}: merged main in and pushed ${r.sha.slice(0, 8)}.`);
    comment(pr, body, { dryRun });
    return true;
  } finally {
    git(['worktree', 'remove', '--force', workdir], { cwd: repo, allowFail: true });
  }
}

const RULE_TEXT = {
  'take-main-and-reindex': "took main's copy (the spec index is generated)",
  'take-main': "took main's copy (docs-site.yml regenerates it if the docs nav changed)",
  union: "kept both sides' entries (an append-only log)",
  'take-main-keep-additions': "kept main's side where they clash (the task list moved to GitHub issues); this PR's side of those lines is below",
};

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const only = env.PR ? Number(env.PR) : null;
  const now = Date.now();
  for (const pr of openPrs().filter((p) => !only || p.number === only)) {
    try {
      // A push since the last give-up is a fresh start.
      if (pr.labels.includes(NEEDS_HUMAN) && !pr.markers.some((m) => m.kind === NEEDS_HUMAN && m.sha === pr.head)) {
        console.log(`#${pr.number}: new head since it was marked ${NEEDS_HUMAN}; trying again.`);
        if (!dryRun) gh(['pr', 'edit', String(pr.number), '--remove-label', NEEDS_HUMAN], { allowFail: true });
      }
      pr.gateAttempt = gateAttempt(pr);
      let d = decide(pr, now);
      if (d.action === 'merge') {
        if (repairConflicts(pr, { dryRun, repo })) continue;
        d = decide({ ...pr, mergeable: 'MERGEABLE' }, now);
      }
      if (d.action === 'skip') {
        console.log(`#${pr.number}: ${d.why}.`);
      } else if (d.action === 'needs-human') {
        needsHuman(pr, d.why, { dryRun });
      } else {
        const kind = d.kind;
        const jobs = jobsFor(pr);
        const baseline = baselineJobs(ciFailures(now), pr.number, now, pr.branch);
        const onMain = onlyBaseline(jobs, baseline);
        const names = jobs.map((j) => `\`${j.name}\``).join(', ');
        if (d.action === 'baseline') {
          recoverBaseline(pr, kind, onMain, { dryRun, retries: d.retries });
        } else if (onMain) {
          // Not this PR's to fix, and not Codex's: no budget spent.
          console.log(`#${pr.number}: ${names} also failing in other PRs' CI runs; waiting for main.`);
          comment(pr, `Queue repair: ${d.why}, but ${names} also failed in the CI runs of at least ${BASELINE_MIN_PRS} other PRs in the last ${BASELINE_WINDOW_MS / 3600000} hours, so this may be a shared baseline failure (job names alone are not proof). On the next pass, newer main is merged in for fresh checks; if main is already included, repair waits for the shared signal to clear. ${marker(`baseline-${kind}`, pr.head)}`, { dryRun });
        } else {
          askCodex(pr, kind, { jobs, why: d.why }, { dryRun });
        }
      }
    } catch (e) {
      console.log(`::warning::#${pr.number}: ${e.message}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

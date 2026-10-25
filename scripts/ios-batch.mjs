// Native iOS in batches: one simulator run covers every open `ci:macos` iOS PR
// that merges cleanly onto main, instead of one 30-minute run per PR per push
// (60 runs on 18 branches in one day, 2026-10-24).
//
// ios-batch.yml runs this on every push to such a PR and every 30 minutes. It
// drops candidates that conflict with main, picks the largest set of the rest
// that merge with each other (oldest first on a tie), merges them onto main,
// squashes the result into one commit on main (so ios-native.yml's appearance scope sees every PR's
// changes as HEAD^1..HEAD), force-pushes it to `ci/ios-batch` and dispatches
// Native iOS there with the batch's PRs and heads. Native iOS posts its result
// to each head as the `Native iOS (batch)` commit status, which `gate`
// (ci-label-gate.mjs) accepts in place of a run on the PR itself.
//
// A batch that matches the last one (same main, same heads) is not run again.
// A red batch marks every PR in it red: dispatch Native iOS on one branch
// (`gh workflow run ios-native.yml --ref <branch>`) to see whether it is yours.
//
// Usage (ios-batch.yml: a full clone, GH_TOKEN and GITHUB_REPOSITORY set):
//   node scripts/ios-batch.mjs [--dry-run]
// --dry-run composes the batch locally and says what it would run, posting nothing.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const BATCH_BRANCH = 'ci/ios-batch';
export const BATCH_CONTEXT = 'Native iOS (batch)';
export const MAX_BATCH = 8;
// Candidates weighed for one batch (2^n subsets); later ones wait for the next.
const MAX_WEIGHED = 12;

/** What Native iOS builds or its live tests drive (ios-native.yml's PR paths). */
export const IOS_PATHS = [/^apps\/ios\//, /^apps\/relay-server\/src\//, /^crates\/nekko-remote\//, /^crates\/nekkod\/src\/remote\.rs$/,
  /^packages\/shared\/src\/(phone-access|pairing-link)\.ts$/, /^\.github\/workflows\/ios-native\.yml$/];

export const touchesIos = files => files.some(f => IOS_PATHS.some(p => p.test(f)));

const labelsOf = pr => (pr.labels ?? []).map(l => (typeof l === 'string' ? l : l.name));

/** The PRs a batch may take, oldest first: ready, same-repo, into main, `ci:macos`, not `hold`, touching iOS. */
export function batchCandidates(prs) {
  return prs
    .filter(pr => !pr.isDraft && !pr.isCrossRepository && pr.baseRefName === 'main')
    .filter(pr => labelsOf(pr).includes('ci:macos') && !labelsOf(pr).includes('hold'))
    .filter(pr => touchesIos((pr.files ?? []).map(f => f.path ?? f)))
    .sort((a, b) => a.number - b.number);
}

/** The batch commit's message; its trailers say which heads it holds. */
export function batchMessage(included) {
  return `Native iOS batch: ${included.map(pr => `#${pr.number}`).join(', ')}\n\n${included.map(pr => `Batch-PR: ${pr.number} ${pr.headRefOid}`).join('\n')}\n`;
}

export function parseBatch(message) {
  return [...message.matchAll(/^Batch-PR: (\d+) ([0-9a-f]{40})$/gm)].map(m => ({ number: Number(m[1]), headRefOid: m[2] }));
}

/**
 * The largest set of candidates (indexes, ascending) with no pair in `conflicts`
 * (a Set of "i,j", i < j); on a tie, the one with the oldest PRs.
 */
export function largestCompatible(count, conflicts) {
  let best = [];
  let bestScore = -1;
  for (let mask = 0; mask < 1 << count; mask++) {
    const set = [...Array(count).keys()].filter(i => mask & (1 << i));
    if (set.some((i, a) => set.slice(a + 1).some(j => conflicts.has(`${i},${j}`)))) continue;
    const score = set.length * count * count - set.reduce((sum, i) => sum + i, 0);
    if (score > bestScore) { best = set; bestScore = score; }
  }
  return best;
}

const sameBatch = (a, b) => a.length === b.length && a.every((pr, i) => pr.number === b[i].number && pr.headRefOid === b[i].headRefOid);

/**
 * Native iOS's verdict on a PR head, from the newest run of ios-native.yml on it
 * and the newest `Native iOS (batch)` status: either one green passes it.
 * `required`: the PR needs Native iOS, so having neither yet means waiting.
 * Returns 'passed' | 'pending' | 'failed' | 'none'.
 */
export function iosVerdict({ run, status, required }) {
  const states = [];
  if (run) states.push(run.status !== 'completed' ? 'pending' : ['success', 'skipped', 'neutral'].includes(run.conclusion) ? 'passed' : 'failed');
  if (status) states.push(status.state === 'success' ? 'passed' : status.state === 'pending' ? 'pending' : 'failed');
  if (states.includes('passed')) return 'passed';
  if (states.includes('pending')) return 'pending';
  if (states.includes('failed')) return 'failed';
  return required ? 'pending' : 'none';
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
}
// The runner has no git identity; commit-tree and commit need one.
const IDENTITY = { GIT_AUTHOR_NAME: 'nekko-ci', GIT_AUTHOR_EMAIL: 'ci@nekkolabs.dev', GIT_COMMITTER_NAME: 'nekko-ci', GIT_COMMITTER_EMAIL: 'ci@nekkolabs.dev' };
const git = (...args) => sh('git', args, { env: { ...process.env, ...IDENTITY } });
const tryGit = (...args) => { try { git(...args); return true; } catch { return false; } };

function setStatus(repo, sha, state, description, url) {
  sh('gh', ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${BATCH_CONTEXT}`,
    '-f', `description=${description.slice(0, 140)}`, ...(url ? ['-f', `target_url=${url}`] : [])]);
}

function main({ dryRun }) {
  const repo = process.env.GITHUB_REPOSITORY;
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const open = JSON.parse(sh('gh', ['pr', 'list', '-R', repo, '--state', 'open', '--limit', '100',
    '--json', 'number,headRefOid,isDraft,isCrossRepository,baseRefName,labels,files']));
  const candidates = batchCandidates(open);
  console.log(`Candidates: ${candidates.map(pr => `#${pr.number}`).join(', ') || 'none'}`);
  if (!candidates.length) return;

  git('fetch', '--quiet', 'origin', 'main', ...candidates.map(pr => `+refs/pull/${pr.number}/head:refs/batch/${pr.number}`));
  const main = git('rev-parse', 'origin/main');
  const skipped = [];
  // Each PR merged onto main alone (in-memory merges: nothing is checked out yet).
  const clean = [];
  for (const pr of candidates) {
    const ref = `refs/batch/${pr.number}`;
    let tree;
    try { tree = git('merge-tree', '--write-tree', main, ref).split('\n')[0]; } catch {
      skipped.push({ pr, why: 'Conflicts with main: merge main to join a batch.', state: 'failure' });
      continue;
    }
    if (clean.length >= MAX_WEIGHED) { skipped.push({ pr, why: 'Waits for the next batch (this one is full).', state: 'pending' }); continue; }
    clean.push({ pr, ref, merged: git('commit-tree', tree, '-p', main, '-p', ref, '-m', `#${pr.number} on main`) });
  }
  const conflicts = new Set();
  clean.forEach((a, i) => clean.slice(i + 1).forEach((b, k) => {
    if (!tryGit('merge-tree', '--write-tree', a.merged, b.ref)) conflicts.add(`${i},${i + 1 + k}`);
  }));
  const chosen = largestCompatible(clean.length, conflicts).slice(0, MAX_BATCH);
  git('checkout', '--quiet', '--detach', main);
  const included = [];
  for (const [i, { pr, ref }] of clean.entries()) {
    const clash = () => clean.filter((_, j) => conflicts.has(`${Math.min(i, j)},${Math.max(i, j)}`) && chosen.includes(j)).map(c => `#${c.pr.number}`);
    if (!chosen.includes(i)) {
      skipped.push({ pr, why: clash().length ? `Conflicts with ${clash().join(', ')}: waits for a later batch.` : 'Waits for the next batch (this one is full).', state: 'pending' });
    } else if (tryGit('merge', '--quiet', '--no-edit', ref)) {
      included.push(pr);
    } else {
      // Clean with each one alone but not with all of them together.
      git('merge', '--abort');
      skipped.push({ pr, why: `Conflicts with ${included.map(p => `#${p.number}`).join(', ')} together: waits for a later batch.`, state: 'pending' });
    }
  }
  for (const { pr, why } of skipped) console.log(`#${pr.number} left out: ${why}`);
  if (dryRun) {
    console.log(`Would run Native iOS once on: ${included.map(pr => `#${pr.number}`).join(', ') || 'nothing'}`);
    return;
  }
  for (const { pr, why, state } of skipped) setStatus(repo, pr.headRefOid, state, why, runUrl);
  if (!included.length) return;

  const last = tryGit('fetch', '--quiet', 'origin', BATCH_BRANCH) ? git('log', '-1', '--format=%B', 'FETCH_HEAD') : '';
  const lastBase = last ? git('rev-parse', 'FETCH_HEAD^') : '';
  if (lastBase === main && sameBatch(parseBatch(last), included)) {
    console.log('Same main and heads as the last batch: nothing to run.');
    return;
  }
  // One commit on main: HEAD^1..HEAD is every PR in the batch.
  git('reset', '--quiet', '--soft', main);
  git('commit', '--quiet', '--allow-empty', '-m', batchMessage(included));
  git('push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${BATCH_BRANCH}`);
  const batch = JSON.stringify(included.map(pr => ({ number: pr.number, sha: pr.headRefOid })));
  sh('gh', ['workflow', 'run', 'ios-native.yml', '-R', repo, '--ref', BATCH_BRANCH, '-f', `batch=${batch}`]);
  const others = pr => included.filter(p => p !== pr).map(p => `#${p.number}`).join(', ');
  for (const pr of included) setStatus(repo, pr.headRefOid, 'pending', `Queued in a batch${others(pr) ? ` with ${others(pr)}` : ''}.`, runUrl);
  console.log(`Dispatched Native iOS on ${BATCH_BRANCH}: ${batch}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main({ dryRun: process.argv.includes('--dry-run') });

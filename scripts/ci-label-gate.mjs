// What `gate` checks beyond ci.yml's own jobs. Two holes let #1001 merge with
// its only Swift compile still queued (#1002):
//
// - `ci:macos` opts a PR into macOS runs in other workflows (the list below),
//   but `gate` needed only ci.yml's jobs, so the queue merged without them.
//   On a labelled PR, `gate` now waits for those runs on the head commit and
//   fails if any of them fails; auto-merge.yml and queue-sweeper.yml enqueue
//   only on a green `gate`, so the queue never sees the PR before macOS is green.
// - Draft and `hold` keep a PR from being queued, but an entry already in the
//   queue still merged. In the queue, `gate` now fails when a PR in the group
//   is a draft or carries `hold`, or carries `ci:macos` without green runs on
//   its head, and the queue ejects it.
//
// Usage (from ci.yml's gate job, with GH_TOKEN and GITHUB_REPOSITORY set):
//   node scripts/ci-label-gate.mjs pr --sha <head sha>
//   node scripts/ci-label-gate.mjs queue --base <group base sha> --head <group head sha>
//
// REST only: a GraphQL hiccup in the queue would eject every group.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MACOS_LABEL = 'ci:macos';
export const HOLD_LABEL = 'hold';

/** The workflows `ci:macos` turns macOS work on in, besides ci.yml itself. */
export const LABEL_WORKFLOWS = [
  '.github/workflows/ios-native.yml',
  '.github/workflows/mobile.yml',
  '.github/workflows/dev-identity.yml',
  '.github/workflows/codeql.yml',
  '.github/workflows/decision-models.yml',
  '.github/workflows/nekkod-npm.yml',
];

/** Run by the queue itself (ci.yml's `ios` job), so a PR head's own run of it does not count there. */
export const QUEUE_RUNS = ['.github/workflows/ios-native.yml'];

const PASSED = new Set(['success', 'skipped', 'neutral']);

/**
 * The newest run of each label workflow among a commit's workflow runs, sorted
 * into pending, failed and passed. A workflow with no run (its path filter
 * skipped the PR) is not waited for.
 */
export function labelRuns(runs, { queue = false } = {}) {
  const newest = new Map();
  for (const run of runs) {
    const path = run.path?.split('@')[0];
    if (!LABEL_WORKFLOWS.includes(path) || (queue && QUEUE_RUNS.includes(path))) continue;
    const seen = newest.get(path);
    if (!seen || run.id > seen.id) newest.set(path, run);
  }
  const out = { pending: [], failed: [], passed: [] };
  for (const run of newest.values()) {
    if (run.status !== 'completed') out.pending.push(run);
    else if (PASSED.has(run.conclusion)) out.passed.push(run);
    else out.failed.push(run);
  }
  return out;
}

/**
 * The PRs in a queue group, from its commits: the queue squashes each PR into
 * one commit whose subject ends `(#123)`.
 */
export function groupPrNumbers(messages) {
  const out = [];
  for (const message of messages) {
    const n = /\(#(\d+)\)\s*$/.exec(message.split('\n')[0])?.[1];
    if (n && !out.includes(Number(n))) out.push(Number(n));
  }
  return out;
}

const labelsOf = pr => (pr.labels?.nodes ?? pr.labels ?? []).map(l => (typeof l === 'string' ? l : l.name));

/** Why each PR in a queue group must not merge yet, apart from its macOS runs. */
export function queueBlockers(prs) {
  const out = [];
  for (const pr of prs) {
    if (pr.isDraft) out.push(`#${pr.number} is a draft.`);
    if (labelsOf(pr).includes(HOLD_LABEL)) out.push(`#${pr.number} is labelled \`${HOLD_LABEL}\`.`);
  }
  return out;
}

export function needsMacos(pr) {
  return labelsOf(pr).includes(MACOS_LABEL);
}

const describe = run => `${run.name} (${run.status === 'completed' ? run.conclusion : run.status}): ${run.html_url}`;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function runsFor(repo, sha) {
  return JSON.parse(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`])).workflow_runs ?? [];
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPr(repo, sha, { timeoutMin, pollSec }) {
  const until = Date.now() + timeoutMin * 60_000;
  for (;;) {
    const state = labelRuns(runsFor(repo, sha));
    if (state.failed.length) {
      console.error(`\`${MACOS_LABEL}\` runs failed on ${sha}:\n${state.failed.map(describe).join('\n')}`);
      return 1;
    }
    if (!state.pending.length) {
      console.log(state.passed.length ? `\`${MACOS_LABEL}\` runs passed:\n${state.passed.map(describe).join('\n')}` : `No \`${MACOS_LABEL}\` runs on ${sha}.`);
      return 0;
    }
    if (Date.now() > until) {
      console.error(`Still waiting after ${timeoutMin} minutes on:\n${state.pending.map(describe).join('\n')}\nRe-run this job once they finish.`);
      return 1;
    }
    console.log(`Waiting on ${state.pending.map(r => r.name).join(', ')}…`);
    await sleep(pollSec * 1000);
  }
}

function checkQueue(repo, base, head) {
  const compare = JSON.parse(gh(['api', `repos/${repo}/compare/${base}...${head}`]));
  const numbers = groupPrNumbers((compare.commits ?? []).map(c => c.commit?.message ?? ''));
  if (!numbers.length) { console.log('No PR numbers in the group\'s commits; nothing to check.'); return 0; }
  const prs = numbers.map(n => {
    const pr = JSON.parse(gh(['api', `repos/${repo}/pulls/${n}`]));
    return { number: pr.number, isDraft: pr.draft, labels: pr.labels ?? [], headRefOid: pr.head?.sha };
  });
  const problems = queueBlockers(prs);
  for (const pr of prs.filter(needsMacos)) {
    const state = labelRuns(runsFor(repo, pr.headRefOid), { queue: true });
    for (const run of [...state.pending, ...state.failed]) problems.push(`#${pr.number} has \`${MACOS_LABEL}\` and ${describe(run)}`);
  }
  if (problems.length) {
    console.error(`Not merging this group:\n${problems.join('\n')}`);
    return 1;
  }
  console.log(`Checked ${prs.map(pr => `#${pr.number}`).join(', ')}.`);
  return 0;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  const mode = process.argv[2];
  let code;
  if (mode === 'pr') {
    code = await waitForPr(repo, arg('sha'), {
      timeoutMin: Number(process.env.CI_LABEL_TIMEOUT_MIN ?? 170),
      pollSec: Number(process.env.CI_LABEL_POLL_SEC ?? 60),
    });
  } else if (mode === 'queue') {
    code = checkQueue(repo, arg('base'), arg('head'));
  } else {
    console.error('usage: ci-label-gate.mjs pr --sha <sha> | queue --base <sha> --head <sha>');
    code = 2;
  }
  process.exit(code);
}

// What `gate` checks beyond ci.yml's own jobs. Two holes let #1001 merge with
// its only Swift compile still queued (#1002):
//
// - A `deploy:<platform>` label (`deploy:linux`, `deploy:windows`,
//   `deploy:macos`, `deploy:ios`, `deploy:android`) opts a PR into that
//   platform's builds in other workflows (the list below), which otherwise run
//   nightly. `gate` needed only ci.yml's jobs, so a PR merged without them.
//   On a labelled PR, `gate` now waits for those runs on the head commit and
//   fails if any of them fails, and main requires `gate`, so the PR cannot
//   merge before they are green.
//
// Draft and `hold` are handled by auto-merge.yml, which disarms auto-merge on
// either (there is no merge queue to eject from since 2026-11-06).
//
// Native iOS runs in batches (scripts/ios-batch.mjs): for a `deploy:ios` PR that
// touches iOS, a green `Native iOS (batch)` status on its head counts as much
// as a green Native iOS run on it, and with neither yet, `gate` waits for one.
//
// Usage (from ci.yml's gate job, with GH_TOKEN and GITHUB_REPOSITORY set):
//   node scripts/ci-label-gate.mjs pr --pr <number> --sha <head sha>

import { execFileSync } from 'node:child_process';
import { BATCH_CONTEXT, iosVerdict, touchesIos } from './ios-batch.mjs';
import { pathToFileURL } from 'node:url';

export const DEPLOY_LABELS = ['deploy:linux', 'deploy:windows', 'deploy:macos', 'deploy:ios', 'deploy:android'];
export const IOS_LABEL = 'deploy:ios';
export const HOLD_LABEL = 'hold';

/** The workflows a deploy label turns platform builds on in, besides ci.yml itself. */
export const LABEL_WORKFLOWS = [
  '.github/workflows/ios-native.yml',
  '.github/workflows/android-native.yml',
  '.github/workflows/installers.yml',
  '.github/workflows/dev-identity.yml',
  '.github/workflows/codeql.yml',
  '.github/workflows/decision-models.yml',
  '.github/workflows/nekkod-npm.yml',
];

const IOS_WORKFLOW = '.github/workflows/ios-native.yml';
const PASSED = new Set(['success', 'skipped', 'neutral']);

/**
 * The newest run of each label workflow among a commit's workflow runs, sorted
 * into pending, failed and passed. A workflow with no run (its path filter
 * skipped the PR) is not waited for.
 *
 * Native iOS also passes on a green batch status (`batch`, the head's newest
 * `Native iOS (batch)` status), and `iosRequired` waits for one when there is
 * neither a run nor a status yet.
 */
export function labelRuns(runs, { batch = null, iosRequired = false } = {}) {
  const newest = new Map();
  for (const run of runs) {
    const path = run.path?.split('@')[0];
    if (!LABEL_WORKFLOWS.includes(path)) continue;
    const seen = newest.get(path);
    if (!seen || run.id > seen.id) newest.set(path, run);
  }
  const out = { pending: [], failed: [], passed: [] };
  for (const run of newest.values()) {
    if (run.status !== 'completed') out.pending.push(run);
    else if (PASSED.has(run.conclusion)) out.passed.push(run);
    else out.failed.push(run);
  }
  if (batch || iosRequired) {
    const run = newest.get(IOS_WORKFLOW);
    for (const list of Object.values(out)) if (list.includes(run)) list.splice(list.indexOf(run), 1);
    const verdict = iosVerdict({ run, status: batch, required: iosRequired });
    const entry = verdict === 'passed' && run && PASSED.has(run.conclusion) ? run
      : { name: 'Native iOS', status: verdict === 'pending' ? 'pending' : 'completed', conclusion: verdict === 'passed' ? 'success' : 'failure',
          html_url: batch?.target_url ?? run?.html_url ?? 'no batch has taken it yet' };
    if (verdict !== 'none') out[verdict].push(entry);
  }
  return out;
}


/** The head's newest `Native iOS (batch)` status, and whether the PR needs Native iOS at all. */
function iosContext(repo, pr, sha, labels) {
  if (!labels.includes(IOS_LABEL)) return {};
  const statuses = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/status`])).statuses ?? [];
  const files = gh(['api', '--paginate', `repos/${repo}/pulls/${pr}/files`, '--jq', '.[].filename']).split('\n').filter(Boolean);
  return { batch: statuses.find(s => s.context === BATCH_CONTEXT) ?? null, iosRequired: touchesIos(files) };
}

const labelsOf = pr => (pr.labels?.nodes ?? pr.labels ?? []).map(l => (typeof l === 'string' ? l : l.name));

export function needsLabelRuns(pr) {
  return labelsOf(pr).some(label => DEPLOY_LABELS.includes(label));
}

const describe = run => `${run.name} (${run.status === 'completed' ? run.conclusion : run.status}): ${run.html_url}`;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function runsFor(repo, sha) {
  return JSON.parse(gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`])).workflow_runs ?? [];
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPr(repo, pr, sha, { timeoutMin, pollSec }) {
  const until = Date.now() + timeoutMin * 60_000;
  const labels = labelsOf(JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}`])));
  for (;;) {
    const state = labelRuns(runsFor(repo, sha), iosContext(repo, pr, sha, labels));
    if (state.failed.length) {
      console.error(`Deploy-label runs failed on ${sha}:\n${state.failed.map(describe).join('\n')}`);
      return 1;
    }
    if (!state.pending.length) {
      console.log(state.passed.length ? `Deploy-label runs passed:\n${state.passed.map(describe).join('\n')}` : `No deploy-label runs on ${sha}.`);
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

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  const mode = process.argv[2];
  let code;
  if (mode === 'pr') {
    code = await waitForPr(repo, arg('pr'), arg('sha'), {
      timeoutMin: Number(process.env.CI_LABEL_TIMEOUT_MIN ?? 170),
      pollSec: Number(process.env.CI_LABEL_POLL_SEC ?? 60),
    });
  } else {
    console.error('usage: ci-label-gate.mjs pr --pr <number> --sha <sha>');
    code = 2;
  }
  process.exit(code);
}

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('CI cancels stale PR revisions without cancelling main runs', () => {
  const ci = read('../.github/workflows/ci.yml');
  assert.ok(ci.includes('group: ci-${{ github.event.pull_request.number || github.run_id }}'));
  assert.ok(ci.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
});

test('CI runs in two tiers: PR and a nightly full run, with no merge queue', () => {
  const on = read('../.github/workflows/ci.yml').split('\njobs:')[0];
  for (const trigger of ['pull_request:', 'schedule:', 'workflow_dispatch:']) assert.ok(on.includes(`\n  ${trigger}`), trigger);
  for (const path of ['ci.yml', 'codeql.yml']) assert.ok(!read(`../.github/workflows/${path}`).includes('merge_group'), path);
  assert.ok(on.includes("cron: '17 18 * * *'"));
  // The nightly run, not a run per merge, covers main.
  assert.ok(!/\n  push:/.test(on));
  assert.ok(!read('../.github/workflows/auto-merge.yml').includes('gh workflow run ci.yml'));
});

test('gate is the single required check and sees every job', () => {
  const gate = read('../.github/workflows/ci.yml').split('\n  gate:')[1];
  assert.ok(gate.includes('needs: [scope, build, daemon, capture, perf, licenses]'));
  assert.ok(gate.includes('if: always()'));
  assert.ok(gate.includes('(failure|cancelled)'));
});

test('auto-merge arms native squash auto-merge on ready PRs into main, and disarms it on draft or hold', () => {
  const merge = read('../.github/workflows/auto-merge.yml');
  const jobs = merge.split('\njobs:')[1];
  const arm = jobs.split('\n  auto-merge:')[1];
  const hold = jobs.split('\n  hold:')[1].split('\n  auto-merge:')[0];
  assert.ok(arm.includes("github.event.pull_request.base.ref == 'main' && !github.event.pull_request.draft && !contains(github.event.pull_request.labels.*.name, 'hold')"));
  assert.ok(arm.includes('gh pr merge --auto --squash "$PR_URL"'));
  assert.ok(hold.includes("github.event.pull_request.draft || contains(github.event.pull_request.labels.*.name, 'hold')"));
  assert.ok(hold.includes('gh pr merge --disable-auto "$PR_URL"'));
  for (const type of ['converted_to_draft', 'labeled', 'unlabeled', 'ready_for_review']) assert.ok(merge.split('\njobs:')[0].includes(type), type);
  assert.ok(!merge.includes('enqueuePullRequest'));
  assert.ok(!merge.includes('mergeQueueEntry'));
});

test('capture builds the verified native browser even on cache hits', () => {
  const capture = read('../.github/workflows/ci.yml').split('\n  capture:')[1].split('\n  perf:')[0];
  for (const input of ['vendor/agent-browser/pin.json', 'vendor/agent-browser/stdio.patch', 'vendor/agent-browser/main.rs', 'scripts/build-agent-browser.mjs']) assert.ok(capture.includes(input));
  assert.ok(capture.includes('.scratch/agent-browser-native/cli/target'));
  assert.ok(capture.includes('dtolnay/rust-toolchain@stable'));
  assert.ok(capture.indexOf('run: node scripts/build-agent-browser.mjs') < capture.indexOf('run: node apps/desktop/scripts/capture-smoke.mjs'));
  assert.ok(!capture.includes('cache-hit'));
  const build = read('./build-agent-browser.mjs');
  assert.ok(build.includes("['build', '--locked', '--profile', profile"));
  assert.ok(build.includes('Build source differs from maintained patch'));
  assert.ok(build.includes("'core.autocrlf=false', '-c', 'core.eol=lf'"));
  assert.ok(read('../.gitattributes').includes('/vendor/agent-browser/* text eol=lf'));
  const smoke = read('../apps/desktop/scripts/capture-smoke.mjs');
  assert.ok(smoke.includes("app.setAppPath(${JSON.stringify(join(root, 'apps/desktop'))})"));
});

test('required build restores a dedicated Rust cache before compiling', () => {
  const build = read('../.github/workflows/ci.yml').split('\n  build:')[1].split('\n  daemon:')[0];
  assert.ok(build.indexOf('Swatinem/rust-cache@v2') < build.indexOf('cargo build -p nekkod --locked'));
  assert.ok(build.includes('shared-key: ci-build'));
  for (const command of ['npm run build:web', 'npm test', 'npm run test:cli-package', 'npm run typecheck']) {
    assert.ok(build.includes(`- run: ${command}`));
  }
});

test('perf reuses the build job\'s web build without waiting for build to finish', () => {
  const ci = read('../.github/workflows/ci.yml');
  const build = ci.split('\n  build:')[1].split('\n  daemon:')[0];
  const perf = ci.split('\n  perf:')[1].split('\n  gate:')[0];
  assert.ok(build.indexOf('npm run build:web') < build.indexOf('name: web-dist'));
  assert.ok(build.indexOf('name: web-dist') < build.indexOf('- run: npm test'));
  // A job-level `needs: build` would serialise perf behind build's tests.
  assert.ok(perf.includes('needs: scope\n'));
  assert.ok(perf.includes('name: web-dist'));
  // The artifact is a shortcut, never a requirement: perf still builds when it is missing.
  assert.ok(perf.includes("if: steps.dist.outputs.ready != 'true'\n        run: npm run build:web"));
});

test('Docker images cannot overwrite each other\'s BuildKit cache scope', () => {
  const docker = read('../.github/workflows/docker.yml');
  for (const scope of ['agent-image', 'relay-image']) {
    assert.ok(docker.includes(`cache-from: type=gha,scope=${scope}`));
    assert.ok(docker.includes(`cache-to: type=gha,mode=max,scope=${scope}`));
  }
});

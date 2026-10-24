import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('CI cancels stale PR revisions without cancelling main runs', () => {
  const ci = read('../.github/workflows/ci.yml');
  assert.ok(ci.includes('group: ci-${{ github.event.pull_request.number || github.run_id }}'));
  assert.ok(ci.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
});

test('CI runs in three tiers: PR, merge queue, and a 6-hourly full run', () => {
  const on = read('../.github/workflows/ci.yml').split('\njobs:')[0];
  for (const trigger of ['pull_request:', 'merge_group:', 'schedule:', 'workflow_dispatch:']) assert.ok(on.includes(`\n  ${trigger}`), trigger);
  assert.ok(on.includes("cron: '17 */6 * * *'"));
  // The queue replaces per-merge runs on main.
  assert.ok(!/\n  push:/.test(on));
  assert.ok(!read('../.github/workflows/auto-merge.yml').includes('gh workflow run ci.yml'));
});

test('gate is the single required check and sees every job', () => {
  const gate = read('../.github/workflows/ci.yml').split('\n  gate:')[1];
  assert.ok(gate.includes('needs: [scope, build, daemon, capture, perf, ios]'));
  assert.ok(gate.includes('if: always()'));
  assert.ok(gate.includes('(failure|cancelled)'));
});

test('auto-merge queues only ready PRs into main, never a stacked layer', () => {
  const merge = read('../.github/workflows/auto-merge.yml');
  assert.ok(merge.includes("!github.event.pull_request.draft && github.event.pull_request.base.ref == 'main'"));
  // A merge method arms classic auto-merge, which never enters a required queue.
  assert.ok(merge.includes('run: gh pr merge --auto "$PR_URL"'));
  assert.ok(!/gh pr merge --auto --(squash|merge|rebase)/.test(merge));
  // ...and an armed request alone did not reliably enter the queue, so it enqueues once gate passes.
  assert.ok(merge.includes('enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head})'));
  assert.ok(merge.indexOf('Enqueue once gate passes') < merge.indexOf('Release the merge'));
  // A GITHUB_TOKEN-made merge group starts no merge_group runs, so the enqueue uses the App token.
  assert.ok(merge.split('Enqueue once gate passes')[1].split('run:')[0].includes('GH_TOKEN: ${{ steps.app-token.outputs.token }}'));
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

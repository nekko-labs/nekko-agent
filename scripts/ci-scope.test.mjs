import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciScope, FILE_LIST_CAP } from './ci-scope.mjs';

const pr = (files, labels = []) => ciScope({ event: 'pull_request', files, labels });
const queue = (files) => ciScope({ event: 'merge_group', files });
const full = { daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: true };
const none = { daemon_os: [], capture_os: [], perf: false };

test('the schedule, main pushes and manual dispatches run every job on every OS', () => {
  for (const event of ['schedule', 'push', 'workflow_dispatch']) assert.deepEqual(ciScope({ event, files: ['README.md'] }), full, event);
});

test('a docs-only change waits for build alone, on the PR and in the queue', () => {
  const docs = ['SPEC.md', 'docs/guide.md', 'apps/website/index.html'];
  assert.deepEqual(pr(docs), none);
  assert.deepEqual(queue(docs), none);
});

test('a Rust change: Linux daemon on the PR; Linux and Windows daemon plus perf in the queue', () => {
  assert.deepEqual(pr(['crates/nekkod/src/main.rs']), { daemon_os: ['ubuntu-latest'], capture_os: [], perf: false });
  assert.deepEqual(queue(['crates/nekkod/src/main.rs']), { daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: [], perf: true });
});

test('a renderer change: Windows capture on the PR; capture and perf in the queue', () => {
  assert.deepEqual(pr(['apps/desktop/src/renderer/App.tsx']), { daemon_os: [], capture_os: ['windows-latest'], perf: false });
  assert.deepEqual(queue(['apps/desktop/src/renderer/App.tsx']), { daemon_os: [], capture_os: ['windows-latest'], perf: true });
});

test('a desktop main-process change skips perf, which measures the web edition', () => {
  assert.equal(queue(['apps/desktop/src/main/index.ts']).perf, false);
});

test('a host change runs the daemon parity job and capture', () => {
  assert.deepEqual(pr(['packages/host/src/tools.ts']), { daemon_os: ['ubuntu-latest'], capture_os: ['windows-latest'], perf: false });
});

test('labels opt a PR into macOS and the speed contract', () => {
  assert.deepEqual(pr(['README.md'], ['ci:macos']), { daemon_os: ['macos-latest'], capture_os: ['macos-latest'], perf: false });
  assert.equal(pr(['README.md'], ['ci:perf']).perf, true);
  assert.equal(pr(['scripts/perf/budgets.mjs']).perf, false);
  assert.equal(queue(['scripts/perf/budgets.mjs']).perf, true);
});

test('macOS never runs in the queue: it runs every 6 hours instead', () => {
  assert.ok(!queue(['crates/nekkod/src/main.rs', 'apps/desktop/src/main/index.ts']).daemon_os.includes('macos-latest'));
});

test('CI, dependency and unknown file lists fall back to every job of the tier', () => {
  for (const files of [['.github/workflows/ci.yml'], ['package-lock.json'], ['scripts/ci-scope.mjs'], [], Array(FILE_LIST_CAP).fill('docs/x.md')]) {
    const label = JSON.stringify(files.slice(0, 1));
    assert.deepEqual(pr(files), { daemon_os: ['ubuntu-latest'], capture_os: ['windows-latest'], perf: false }, label);
    assert.deepEqual(queue(files), { daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: ['windows-latest'], perf: true }, label);
  }
});

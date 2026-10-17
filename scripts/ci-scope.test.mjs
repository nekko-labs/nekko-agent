import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciScope, FILE_LIST_CAP } from './ci-scope.mjs';

const pr = (files, labels = []) => ciScope({ event: 'pull_request', files, labels });
const full = { daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: true };

test('main pushes and manual dispatches run every job on every platform', () => {
  assert.deepEqual(ciScope({ event: 'push', files: ['README.md'] }), full);
  assert.deepEqual(ciScope({ event: 'workflow_dispatch' }), full);
});

test('a docs-only PR waits for build alone', () => {
  assert.deepEqual(pr(['SPEC.md', 'docs/guide.md', 'apps/website/index.html']), { daemon_os: [], capture_os: [], perf: false });
});

test('a Rust change runs the Linux and Windows daemon jobs, not capture, macOS or perf', () => {
  assert.deepEqual(pr(['crates/nekkod/src/main.rs']), { daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: [], perf: false });
});

test('a desktop UI change runs Windows capture only', () => {
  assert.deepEqual(pr(['apps/desktop/src/renderer/App.tsx']), { daemon_os: [], capture_os: ['windows-latest'], perf: false });
});

test('a host change runs the daemon parity job and capture', () => {
  assert.deepEqual(pr(['packages/host/src/tools.ts']), { daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: ['windows-latest'], perf: false });
});

test('labels opt a PR into macOS and the speed contract', () => {
  assert.deepEqual(pr(['README.md'], ['ci:macos']), { daemon_os: ['macos-latest'], capture_os: ['macos-latest'], perf: false });
  assert.equal(pr(['README.md'], ['ci:perf']).perf, true);
  assert.equal(pr(['scripts/perf/budgets.mjs']).perf, true);
});

test('CI, dependency and unknown file lists fall back to all Linux and Windows jobs', () => {
  const linuxWindows = { daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: ['windows-latest'], perf: false };
  for (const files of [['.github/workflows/ci.yml'], ['package-lock.json'], ['scripts/ci-scope.mjs'], [], Array(FILE_LIST_CAP).fill('docs/x.md')]) {
    assert.deepEqual(pr(files), linuxWindows, JSON.stringify(files.slice(0, 1)));
  }
});

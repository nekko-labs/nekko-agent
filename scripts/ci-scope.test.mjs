import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ciScope, FILE_LIST_CAP } from './ci-scope.mjs';

const pr = (files, labels = []) => ciScope({ event: 'pull_request', files, labels });
const queue = (files) => ciScope({ event: 'merge_group', files });
const full = { daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: true, itests: true };
// Every PR result carries itests: false; every queue result, itests: true.
const p = (scope) => ({ ...scope, itests: false });
const q = (scope) => ({ ...scope, itests: true });
const none = { daemon_os: [], capture_os: [], perf: false };

test('the schedule, main pushes and manual dispatches run every job on every OS', () => {
  for (const event of ['schedule', 'push', 'workflow_dispatch']) assert.deepEqual(ciScope({ event, files: ['README.md'] }), full, event);
});

test('a docs-only change waits for build alone, on the PR and in the queue', () => {
  const docs = ['SPEC.md', 'docs/guide.md', 'apps/website/index.html'];
  assert.deepEqual(pr(docs), p(none));
  assert.deepEqual(queue(docs), q(none));
});

test('a Rust change: Linux daemon on the PR; Linux and Windows daemon plus perf in the queue', () => {
  assert.deepEqual(pr(['crates/nekkod/src/main.rs']), p({ daemon_os: ['ubuntu-latest'], capture_os: [], perf: false }));
  assert.deepEqual(queue(['crates/nekkod/src/main.rs']), q({ daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: [], perf: true }));
});

test('a renderer change: Windows capture on the PR; capture and perf in the queue', () => {
  assert.deepEqual(pr(['apps/desktop/src/renderer/App.tsx']), p({ daemon_os: [], capture_os: ['windows-latest'], perf: false }));
  assert.deepEqual(queue(['apps/desktop/src/renderer/App.tsx']), q({ daemon_os: [], capture_os: ['windows-latest'], perf: true }));
});

test('a desktop main-process change skips perf, which measures the Local Web UI', () => {
  assert.equal(queue(['apps/desktop/src/main/index.ts']).perf, false);
});

test('a host change runs the daemon parity job and capture', () => {
  assert.deepEqual(pr(['packages/host/src/tools.ts']), p({ daemon_os: ['ubuntu-latest'], capture_os: ['windows-latest'], perf: false }));
});

test('labels opt a PR into macOS and the speed contract', () => {
  assert.deepEqual(pr(['README.md'], ['ci:macos']), p({ daemon_os: ['macos-latest'], capture_os: ['macos-latest'], perf: false }));
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
    assert.deepEqual(pr(files), p({ daemon_os: ['ubuntu-latest'], capture_os: ['windows-latest'], perf: false }), label);
    assert.deepEqual(queue(files), q({ daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: ['windows-latest'], perf: true }), label);
  }
});

test('the loopback itests never run on a PR, whatever it touches or is labelled', () => {
  for (const files of [['crates/nekkod/src/main.rs'], ['scripts/itest-relay-daemon.mjs'], ['.github/workflows/ci.yml'], []]) {
    assert.equal(pr(files, ['ci:macos', 'ci:perf']).itests, false, JSON.stringify(files));
  }
  assert.equal(queue(['README.md']).itests, true);
});

// The workflow's wiring for them: the job follows the scope output and does
// not hold the required check, so a red itest never blocks a PR or the queue.
test('ci.yml runs the itests job from the scope and keeps it out of gate', () => {
  const yml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(yml, /^ {6}itests: \$\{\{ steps\.scope\.outputs\.itests \}\}$/m, 'scope exposes itests');
  const job = yml.match(/^ {2}itests:\n([\s\S]*?)(?=^ {2}\S)/m)?.[1];
  assert.ok(job, 'an itests job');
  assert.match(job, /^ {4}if: needs\.scope\.outputs\.run == 'true' && needs\.scope\.outputs\.itests == 'true'$/m);
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m);
  for (const script of ['itest-turn-variants', 'itest-relay-daemon', 'itest-messaging-daemon', 'itest-small-services', 'itest-mcp-http']) {
    assert.ok(job.includes(`scripts/${script}.mjs`), `${script} runs`);
  }
  const gate = yml.match(/^ {2}gate:\n {4}needs: \[([^\]]*)\]/m)?.[1];
  assert.ok(gate, 'a gate job');
  assert.ok(!gate.split(',').map((s) => s.trim()).includes('itests'), 'gate does not wait for itests');
});

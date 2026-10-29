import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ciScope, codeqlLanguages, FILE_LIST_CAP } from './ci-scope.mjs';

const pr = (files, labels = []) => ciScope({ event: 'pull_request', files, labels });
const queue = (files) => ciScope({ event: 'merge_group', files });
const full = { build: true, daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: true, itests: true };
// Every PR result carries itests: false; every queue result, itests: true. Both build, unless a test says not.
const p = (scope) => ({ build: true, ...scope, itests: false });
const q = (scope) => ({ build: true, ...scope, itests: true });
const none = { daemon_os: [], capture_os: [], perf: false };

test('the schedule, main pushes and manual dispatches run every job on every OS', () => {
  for (const event of ['schedule', 'push', 'workflow_dispatch']) assert.deepEqual(ciScope({ event, files: ['README.md'] }), full, event);
});

test('a docs-only change waits for build alone, on the PR and in the queue', () => {
  const docs = ['spec/chat/find-in-this-chat.md', 'docs/guide.md', 'apps/website/index.html'];
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

test('a native browser patch or build-script change runs Windows capture, which builds it', () => {
  for (const file of ['vendor/agent-browser/stdio.patch', 'scripts/build-agent-browser.mjs']) {
    assert.deepEqual(pr([file]), p({ daemon_os: [], capture_os: ['windows-latest'], perf: false }), file);
  }
});

test('a desktop main-process change skips perf, which measures the Local Web UI', () => {
  assert.equal(queue(['apps/desktop/src/main/index.ts']).perf, false);
});

test('a shared contract change runs the daemon job and capture', () => {
  assert.deepEqual(pr(['packages/shared/src/phone-access.ts']), p({ daemon_os: ['ubuntu-latest'], capture_os: ['windows-latest'], perf: false }));
});

test('a profile change runs capture but not the daemon', () => {
  assert.deepEqual(pr(['packages/profile/src/user-data.ts']), p({ daemon_os: [], capture_os: ['windows-latest'], perf: false }));
});

test('labels opt a PR into macOS and the speed contract', () => {
  assert.deepEqual(pr(['crates/nekkod/src/main.rs', 'apps/desktop/src/main/index.ts'], ['ci:macos']),
    p({ daemon_os: ['ubuntu-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: false }));
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

test('ci:macos adds macOS only to the jobs a change already needs', () => {
  // #1023: two Swift UI test files with ci:macos ran the Rust daemon and desktop capture on macOS.
  assert.deepEqual(pr(['apps/ios/UITests/ComputersTests.swift'], ['ci:macos']), p({ build: false, daemon_os: [], capture_os: [], perf: false }));
  assert.deepEqual(pr(['README.md'], ['ci:macos']), p({ daemon_os: [], capture_os: [], perf: false }));
  assert.deepEqual(pr(['crates/nekkod/src/main.rs'], ['ci:macos']).capture_os, []);
});

test('a change only to the native phone apps skips build, on the PR and in the queue', () => {
  const native = ['apps/ios/App/AppModel.swift', 'apps/ios/project.yml', 'apps/android/app/src/main/java/Main.kt'];
  assert.deepEqual(pr(native), p({ build: false, daemon_os: [], capture_os: [], perf: false }));
  assert.deepEqual(queue(native), { build: false, daemon_os: [], capture_os: [], perf: false, itests: false });
  // Anything else alongside, even docs, builds; so does an unknown list.
  assert.equal(pr([...native, 'docs/guide.md']).build, true);
  assert.equal(pr([...native, 'packages/shared/src/phone-access.ts']).build, true);
  assert.equal(pr([]).build, true);
  assert.equal(ciScope({ event: 'schedule', files: native }).build, true);
});

test('CodeQL analyses the languages a change is in', () => {
  const langs = (files, labels = [], event = 'pull_request') => codeqlLanguages({ event, files, labels });
  assert.deepEqual(langs(['apps/ios/UITests/ComputersTests.swift']), []);
  assert.deepEqual(langs(['apps/ios/UITests/ComputersTests.swift'], ['ci:macos']), ['swift']);
  assert.deepEqual(langs(['apps/desktop/src/renderer/App.tsx', 'scripts/x.mjs']), ['javascript-typescript']);
  assert.deepEqual(langs(['crates/nekkod/src/main.rs', 'Cargo.lock']), ['rust']);
  assert.deepEqual(langs(['scripts/perf/plot.py', '.github/workflows/android-native.yml']), ['actions', 'python']);
  assert.deepEqual(langs(['docs/guide.md', 'spec/README.md']), []);
  // Unknown or CI changes: every Linux language, Swift too with ci:macos on a PR; never Swift in the queue.
  assert.deepEqual(langs([]), ['actions', 'javascript-typescript', 'python', 'rust']);
  assert.deepEqual(langs(['.github/workflows/codeql.yml'], ['ci:macos']), ['actions', 'javascript-typescript', 'python', 'rust', 'swift']);
  assert.deepEqual(langs(['apps/ios/A.swift'], ['ci:macos'], 'merge_group'), []);
  assert.deepEqual(langs(['README.md'], [], 'schedule'), ['actions', 'javascript-typescript', 'python', 'rust', 'swift']);
});

test('ci.yml skips build from the scope, and the compliance check runs in scope for every change', () => {
  const yml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(yml, /^ {6}build: \$\{\{ steps\.scope\.outputs\.build \}\}$/m);
  const job = name => yml.match(new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S)`, 'm'))?.[1] ?? '';
  assert.match(job('build'), /^ {4}if: needs\.scope\.outputs\.run == 'true' && needs\.scope\.outputs\.build == 'true'$/m);
  assert.ok(job('scope').includes('node scripts/check-claude-compliance.mjs'));
  assert.ok(!job('scope').includes('sparse-checkout'), 'the compliance check scans the whole tree');
});

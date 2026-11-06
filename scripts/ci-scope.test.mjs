import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ciScope, codeqlLanguages, FILE_LIST_CAP } from './ci-scope.mjs';

const pr = (files, labels = []) => ciScope({ event: 'pull_request', files, labels });
const full = { build: true, daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: true, itests: true, licenses: false };
// Every PR result carries itests: false and builds, unless a test says not.
const p = (scope) => ({ build: true, licenses: false, ...scope, itests: false });
const none = { daemon_os: [], capture_os: [], perf: false };

test('the schedule, main pushes and manual dispatches run every job on every OS', () => {
  for (const event of ['schedule', 'push', 'workflow_dispatch']) assert.deepEqual(ciScope({ event, files: ['README.md'] }), full, event);
});

test('a docs-only change waits for build alone', () => {
  const docs = ['spec/chat/find-in-this-chat.md', 'docs/guide.md', 'apps/website/index.html'];
  assert.deepEqual(pr(docs), p(none));
});

test('a Rust change: no per-OS daemon on the PR without a label, and no perf: that runs nightly', () => {
  assert.deepEqual(pr(['crates/nekkod/src/main.rs']), p(none));
  assert.deepEqual(pr(['crates/nekkod/src/main.rs'], ['deploy:linux', 'deploy:windows']), p({ daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: [], perf: false }));
});

test('a renderer change: capture only with deploy:windows on the PR', () => {
  assert.deepEqual(pr(['apps/desktop/src/renderer/App.tsx']), p(none));
  assert.deepEqual(pr(['apps/desktop/src/renderer/App.tsx'], ['deploy:windows']), p({ daemon_os: [], capture_os: ['windows-latest'], perf: false }));
});

test('a native browser patch or build-script change runs capture, which builds it, with deploy:windows', () => {
  for (const file of ['vendor/agent-browser/stdio.patch', 'scripts/build-agent-browser.mjs']) {
    assert.deepEqual(pr([file], ['deploy:windows']), p({ daemon_os: [], capture_os: ['windows-latest'], perf: false }), file);
  }
});

test('a shared contract change runs the daemon job and capture', () => {
  assert.deepEqual(pr(['packages/shared/src/phone-access.ts'], ['deploy:linux', 'deploy:windows']), p({ daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: ['windows-latest'], perf: false }));
});

test('a profile change runs capture but not the daemon', () => {
  assert.deepEqual(pr(['packages/profile/src/user-data.ts'], ['deploy:linux', 'deploy:windows']), p({ daemon_os: [], capture_os: ['windows-latest'], perf: false }));
});

test('labels opt a PR into each OS and the speed contract', () => {
  assert.deepEqual(pr(['crates/nekkod/src/main.rs', 'apps/desktop/src/main/index.ts'], ['deploy:macos']),
    p({ daemon_os: ['macos-latest'], capture_os: ['macos-latest'], perf: false }));
  assert.deepEqual(pr(['crates/nekkod/src/main.rs', 'apps/desktop/src/main/index.ts'], ['deploy:linux', 'deploy:windows', 'deploy:macos']),
    p({ daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: false }));
  assert.equal(pr(['README.md'], ['ci:perf']).perf, true);
  assert.equal(pr(['scripts/perf/budgets.mjs']).perf, false);
});

test('there is no merge queue tier: a merge_group event runs only what a PR would', () => {
  const files = ['crates/nekkod/src/main.rs', 'scripts/perf/budgets.mjs'];
  assert.deepEqual(ciScope({ event: 'merge_group', files }), pr(files));
});

test('CI, dependency and unknown file lists fall back to every job of the tier', () => {
  for (const files of [['.github/workflows/ci.yml'], ['package-lock.json'], ['scripts/ci-scope.mjs'], [], Array(FILE_LIST_CAP).fill('docs/x.md')]) {
    const label = JSON.stringify(files.slice(0, 1));
    assert.deepEqual(pr(files), p({ daemon_os: [], capture_os: [], perf: false, licenses: true }), label);
    assert.deepEqual(pr(files, ['deploy:linux', 'deploy:windows']), p({ daemon_os: ['ubuntu-latest', 'windows-latest'], capture_os: ['windows-latest'], perf: false, licenses: true }), label);
  }
});

test('the loopback itests never run on a PR, whatever it touches or is labelled', () => {
  for (const files of [['crates/nekkod/src/main.rs'], ['scripts/itest-relay-daemon.mjs'], ['.github/workflows/ci.yml'], []]) {
    assert.equal(pr(files, ['deploy:macos', 'ci:perf']).itests, false, JSON.stringify(files));
  }
  assert.equal(ciScope({ event: 'schedule', files: ['README.md'] }).itests, true);
});

// The workflow's wiring for them: the job follows the scope output and does
// not hold the required check, so a red itest never blocks a PR.
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

test('a deploy label adds its OS only to the jobs a change already needs', () => {
  // #1023: two Swift UI test files with a macOS label ran the Rust daemon and desktop capture on macOS.
  assert.deepEqual(pr(['apps/ios/UITests/ComputersTests.swift'], ['deploy:macos']), p({ build: false, daemon_os: [], capture_os: [], perf: false }));
  assert.deepEqual(pr(['README.md'], ['deploy:macos', 'deploy:windows']), p({ daemon_os: [], capture_os: [], perf: false }));
  assert.deepEqual(pr(['crates/nekkod/src/main.rs'], ['deploy:macos']).capture_os, []);
});

test('a change only to the native phone apps skips build', () => {
  const native = ['apps/ios/App/AppModel.swift', 'apps/ios/project.yml', 'apps/android/app/src/main/java/Main.kt'];
  assert.deepEqual(pr(native), p({ build: false, daemon_os: [], capture_os: [], perf: false }));
  // Anything else alongside, even docs, builds; so does an unknown list.
  assert.equal(pr([...native, 'docs/guide.md']).build, true);
  assert.equal(pr([...native, 'packages/shared/src/phone-access.ts']).build, true);
  assert.equal(pr([]).build, true);
  assert.equal(ciScope({ event: 'schedule', files: native }).build, true);
});

test('CodeQL analyses the languages a change is in', () => {
  const langs = (files, labels = [], event = 'pull_request') => codeqlLanguages({ event, files, labels });
  assert.deepEqual(langs(['apps/ios/UITests/ComputersTests.swift']), []);
  assert.deepEqual(langs(['apps/ios/UITests/ComputersTests.swift'], ['deploy:ios']), ['swift']);
  assert.deepEqual(langs(['apps/desktop/src/renderer/App.tsx', 'scripts/x.mjs']), ['javascript-typescript']);
  assert.deepEqual(langs(['crates/nekkod/src/main.rs', 'Cargo.lock']), ['rust']);
  assert.deepEqual(langs(['scripts/perf/plot.py', '.github/workflows/android-native.yml']), ['actions', 'python']);
  assert.deepEqual(langs(['docs/guide.md', 'spec/README.md']), []);
  // Unknown or CI changes: every Linux language, Swift too with deploy:ios on a PR.
  assert.deepEqual(langs([]), ['actions', 'javascript-typescript', 'python', 'rust']);
  assert.deepEqual(langs(['.github/workflows/codeql.yml'], ['deploy:ios']), ['actions', 'javascript-typescript', 'python', 'rust', 'swift']);
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

test('the license check runs only when dependencies or the assets list change', () => {
  for (const files of [['apps/desktop/package.json'], ['crates/nekkod/Cargo.toml'], ['Cargo.lock'], ['ASSETS.md'], ['scripts/license-policy.json']]) {
    assert.equal(pr(files).licenses, true, JSON.stringify(files));
  }
  assert.equal(pr(['README.md']).licenses, false);
  assert.equal(pr(['apps/desktop/src/renderer/App.tsx']).licenses, false);
  assert.equal(ciScope({ event: 'schedule' }).licenses, false);
});

// The Team plan gives the org 5 macOS runners, shared by every workflow, and they are
// the CI's bottleneck: in November 2026 evidence and diagnostic runs took about a third
// of their time while Native iOS runs, which `gate` waits for, queued for hours.
// These checks keep new macOS work off automatic triggers. Evidence runs locally on a
// Mac (scripts/ios-evidence-local.mjs) or by hand (workflow_dispatch); a platform build
// that must run per PR or nightly is added to PLATFORM_BUILDS on purpose.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const AUTOMATIC = ['pull_request', 'pull_request_target', 'push', 'schedule', 'workflow_run', 'merge_group'];

/** The workflows allowed to start macOS jobs on their own: the platform builds behind `deploy:*` labels and the nightly. */
export const PLATFORM_BUILDS = new Set([
  'ci.yml',
  'codeql.yml',
  'decision-models.yml',
  'dev-identity.yml',
  'installers.yml',
  'ios-native.yml',
  'ios-testflight.yml',
  'nekkod-npm.yml',
  'release.yml',
]);

/** The top-level trigger names in a workflow file. */
export function triggers(text) {
  const block = text.match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m);
  if (block) return [...block[1].matchAll(/^ {2}([a-z_]+):/gm)].map(m => m[1]);
  const inline = text.match(/^on:\s*\[?([^\n\]]+)\]?\s*$/m);
  return inline ? inline[1].split(',').map(s => s.trim()) : [];
}

/** Whether a workflow file can ask for a macOS runner (hosted label, our Xcode image, or the self-hosted Mac). */
export function usesMac(text) {
  return /\b(macos-[a-z0-9.-]+|xcode-\d+|nekko-cloud-mac)\b/.test(text);
}

const workflows = fs.readdirSync(DIR).filter(f => /\.ya?ml$/.test(f)).map(f => ({ file: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));

test('the trigger and macOS parsers read real workflow shapes', () => {
  assert.deepEqual(triggers('name: x\non:\n  pull_request:\n    paths: [a]\n  workflow_dispatch:\njobs:\n'), ['pull_request', 'workflow_dispatch']);
  assert.deepEqual(triggers('on: [push, pull_request]\n'), ['push', 'pull_request']);
  assert.deepEqual(triggers('on: workflow_dispatch\n'), ['workflow_dispatch']);
  assert.equal(usesMac('    runs-on: xcode-27\n'), true);
  assert.equal(usesMac("    runs-on: ${{ matrix.language == 'swift' && 'macos-latest' || 'ubuntu-latest' }}\n"), true);
  assert.equal(usesMac('    runs-on: ubuntu-latest\n'), false);
});

test('only the platform builds start macOS jobs automatically', () => {
  const offenders = workflows
    .filter(w => usesMac(w.text) && triggers(w.text).some(t => AUTOMATIC.includes(t)) && !PLATFORM_BUILDS.has(w.file))
    .map(w => `${w.file} (${triggers(w.text).join(', ')})`);
  assert.deepEqual(offenders, [], 'Run iPhone evidence and diagnostics locally (scripts/ios-evidence-local.mjs) or behind workflow_dispatch, not on an automatic trigger');
});

test('evidence and diagnostic workflows never run automatically', () => {
  const offenders = workflows
    .filter(w => /evidence|diagnostic|matched/i.test(`${w.file}\n${w.text.match(/^name:.*$/m)?.[0] ?? ''}`))
    .filter(w => triggers(w.text).some(t => AUTOMATIC.includes(t)))
    .map(w => w.file);
  assert.deepEqual(offenders, []);
});

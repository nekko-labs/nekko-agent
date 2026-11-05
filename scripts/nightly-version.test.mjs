import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalReleaseTag, currentLine, parseReleaseTag, planVersion, run, storeCode } from './nightly-version.mjs';

// The repo's tags today: releases up to v0.8.2, plus tags that are not releases.
const today = ['v0.1.4', 'v0.7.1', 'v0.8.0', 'v0.8.1', 'v0.8.2', 'decision-models-v1', 'pr-1386-media', 'v1.0.0-rc.1'];

test('release tags parse in both forms; suffixes and other prefixes are not releases', () => {
  assert.deepEqual(parseReleaseTag('v0.9'), { major: 0, minor: 9, patch: null });
  assert.deepEqual(parseReleaseTag('v0.8.2'), { major: 0, minor: 8, patch: 2 });
  for (const t of ['v1.0.0-rc.1', 'decision-models-v1', 'nightly/ios/v0.9.1', '0.9.0', 'v0.9.0.1']) assert.equal(parseReleaseTag(t), null, t);
  assert.equal(canonicalReleaseTag('v0.9'), 'v0.9.0');
  assert.equal(canonicalReleaseTag('v1.2.0'), 'v1.2.0');
  assert.throws(() => canonicalReleaseTag('v1.2.0-beta'));
});

test('the line is the newest MAJOR.MINOR, compared numerically, ignoring prereleases', () => {
  assert.deepEqual(currentLine(today), { major: 0, minor: 8 });
  assert.deepEqual(currentLine([...today, 'v0.10']), { major: 0, minor: 10 });
  assert.deepEqual(currentLine([...today, 'v1.0']), { major: 1, minor: 0 });
  assert.throws(() => currentLine(['pr-1-media']), /No release tag/);
});

test('first builds after this change: desktop above the shipped v0.8.2, phones from 1', () => {
  assert.deepEqual(planVersion({ tags: today, platform: 'desktop' }),
    { platform: 'desktop', version: '0.8.3', code: 80003, tag: 'nightly/desktop/v0.8.3', reused: false });
  assert.equal(planVersion({ tags: today, platform: 'ios' }).version, '0.8.1');
  assert.equal(planVersion({ tags: today, platform: 'ios' }).code, 80001);
  assert.equal(planVersion({ tags: today, platform: 'android' }).version, '0.8.1');
});

test('each platform counts its own builds', () => {
  const tags = [...today, 'nightly/ios/v0.8.1', 'nightly/ios/v0.8.2', 'nightly/ios/v0.8.7', 'nightly/android/v0.8.1', 'nightly/desktop/v0.8.3'];
  assert.equal(planVersion({ tags, platform: 'ios' }).version, '0.8.8');
  assert.equal(planVersion({ tags, platform: 'android' }).version, '0.8.2');
  assert.equal(planVersion({ tags, platform: 'desktop' }).version, '0.8.4');
});

test('a manual MAJOR.MINOR tag resets every counter', () => {
  const tags = [...today, 'nightly/ios/v0.8.40', 'nightly/desktop/v0.8.9', 'v0.9'];
  assert.equal(planVersion({ tags, platform: 'ios' }).version, '0.9.1');
  assert.equal(planVersion({ tags, platform: 'ios' }).code, 90001);
  assert.equal(planVersion({ tags, platform: 'desktop' }).version, '0.9.1');
  // The release workflow turns v0.9 into v0.9.0; that is BUILD 0, still 0.9.1 next.
  assert.equal(planVersion({ tags: [...tags, 'v0.9.0'], platform: 'desktop' }).version, '0.9.1');
  // A desktop nightly promoted to a release (v0.9.4) is skipped by the next nightly.
  assert.equal(planVersion({ tags: [...tags, 'v0.9.0', 'nightly/desktop/v0.9.3', 'v0.9.4'], platform: 'desktop' }).version, '0.9.5');
});

test('store codes increase across every build and line, and refuse to overflow', () => {
  const seq = [[0, 8, 1], [0, 8, 9999], [0, 9, 0], [0, 9, 1], [0, 999, 9999], [1, 0, 0], [209, 999, 9999]];
  const codes = seq.map(([major, minor, build]) => storeCode({ major, minor, build }));
  for (let i = 1; i < codes.length; i++) assert.ok(codes[i] > codes[i - 1], `${seq[i]} after ${seq[i - 1]}`);
  assert.equal(storeCode({ major: 0, minor: 8, build: 1 }), 80001);
  // Above every build already uploaded: TestFlight used run number + 100 (179 by 2026-11-05), Android versionCode 1.
  assert.ok(codes[0] > 179);
  assert.ok(codes.at(-1) <= 2_100_000_000);
  assert.throws(() => storeCode({ major: 0, minor: 8, build: 10000 }), /tag a new MAJOR.MINOR/);
  assert.throws(() => storeCode({ major: 0, minor: 1000, build: 0 }), /bump MAJOR/);
  assert.throws(() => storeCode({ major: 210, minor: 0, build: 1 }), /over/);
});

test('reuse-same-commit returns the version the commit already has, else a new one', () => {
  const tags = [...today, 'nightly/android/v0.8.1', 'nightly/android/v0.8.2'];
  assert.deepEqual(planVersion({ tags, platform: 'android', reuseSameCommit: true, tagsAtCommit: ['nightly/android/v0.8.2'] }),
    { platform: 'android', version: '0.8.2', code: 80002, tag: 'nightly/android/v0.8.2', reused: true });
  // Another platform's tag, or one from an older line, does not count.
  const other = planVersion({ tags: [...tags, 'v0.9'], platform: 'android', reuseSameCommit: true, tagsAtCommit: ['nightly/android/v0.8.2', 'nightly/ios/v0.9.1'] });
  assert.deepEqual([other.version, other.reused], ['0.9.1', false]);
  assert.equal(planVersion({ tags, platform: 'android', tagsAtCommit: ['nightly/android/v0.8.2'] }).version, '0.8.3');
  assert.throws(() => planVersion({ tags, platform: 'watch' }), /Unknown platform/);
});

// The reserve path against a real (local, bare) remote: tags are pushed, a
// second run counts on, a lost race moves to the next number.
test('reserve pushes the counter tag and a concurrent reservation takes the next number', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nightly-version-'));
  const cwd = process.cwd();
  // Leave the temp dir before deleting it (Windows refuses to remove a cwd).
  // Hermetic git: no global or system config (a CI runner has no identity and
  // no init.defaultBranch), and nothing inherited that points git elsewhere.
  // Set on process.env because run() under test spawns git too.
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^GIT_/.test(k)) delete process.env[k];
  const emptyConfig = join(dir, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' });
  t.after(() => {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  });
  const g =(cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = join(dir, 'remote.git');
  // Name the branch: with no init.defaultBranch the bare HEAD names master, and
  // a clone of a remote that only has main gets an unborn HEAD (the CI failure).
  g(dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  const clone = name => {
    const c = join(dir, name);
    g(dir, 'clone', '--quiet', remote, c);
    g(c, 'config', 'user.email', 't@example.com');
    g(c, 'config', 'user.name', 't');
    return c;
  };
  const a = clone('a');
  g(a, 'commit', '--quiet', '--allow-empty', '-m', 'one');
  g(a, 'tag', 'v0.8.2');
  g(a, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main', 'v0.8.2');
  const b = clone('b');
  const head = g(a, 'rev-parse', 'HEAD');
  assert.equal(g(b, 'rev-parse', 'HEAD'), head, 'the second clone checked out the pushed commit');

  const reserve = (repo, opts = {}) => { process.chdir(repo); return run({ platform: 'android', reserve: true, log: () => {}, ...opts }); };

  assert.equal(reserve(a).version, '0.8.1');
  assert.match(g(a, 'ls-remote', '--tags', 'origin'), /refs\/tags\/nightly\/android\/v0\.8\.1/);
  // Same commit, reuse: no new tag.
  assert.deepEqual([reserve(a, { reuseSameCommit: true }).version, reserve(a, { reuseSameCommit: true }).reused], ['0.8.1', true]);
  // b has not fetched a's tag but reserve fetches first, so it counts on.
  assert.equal(reserve(b).version, '0.8.2');
  // A lost race: between b's fetch and b's push, a takes 0.8.3.
  let raced = false;
  const r = reserve(b, { beforePush: plan => {
    if (raced) return;
    raced = true;
    assert.equal(plan.version, '0.8.3');
    assert.equal(reserve(a).version, '0.8.3');
    process.chdir(b);
  } });
  assert.equal(r.version, '0.8.4');
  // The dry run pushes nothing.
  process.chdir(a);
  assert.equal(run({ platform: 'android', reserve: false }).version, '0.8.4', 'a has not fetched b\'s tag');
  const pushed = g(a, 'ls-remote', '--tags', 'origin').split('\n').filter(l => l.includes('nightly/') && !l.endsWith('^{}')).map(l => l.split('refs/tags/')[1]);
  assert.deepEqual(pushed.sort(), ['nightly/android/v0.8.1', 'nightly/android/v0.8.2', 'nightly/android/v0.8.3', 'nightly/android/v0.8.4']);
});

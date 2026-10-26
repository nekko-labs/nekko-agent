import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = 'scripts/runner-image';
const boot = join(dir, 'nekko-runner-boot.sh');
const plist = join(dir, 'dev.nekkolabs.runner-boot.plist');

// One temp root per run: bin/ stubs first on PATH, every stub appends `name args...` to calls.log.
let root;
let home;
function stubs() {
  root = mkdtempSync(join(tmpdir(), 'runner-image-'));
  home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(home, 'actions-runner'), { recursive: true });
  const log = join(root, 'calls.log');
  const stub = (name, body = '') =>
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  stub('diskutil');
  stub('chown');
  stub('shutdown');
  stub('id', 'echo 501');
  stub('stat', 'echo "${FAKE_CONSOLE:-runner}"');
  stub('launchctl', 'shift 2; exec "$@"');
  // Exec only commands inside the temp root, so a real /usr/local/bin/gitlab-runner never runs.
  stub('sudo', `shift 4; case "$1" in '${root}'/*) exec "$@";; esac`);
  writeFileSync(join(home, 'actions-runner/run.sh'), `#!/bin/bash\necho "run.sh $*" >> '${log}'\nexit "\${FAKE_EXIT:-0}"\n`, { mode: 0o755 });
}

function seed(files) {
  const s = join(root, 'seed');
  mkdirSync(s);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(s, name), body);
  return s;
}

function run({ seed: files, env = {}, prepare } = {}) {
  stubs();
  const seedDir = files ? seed(files) : join(root, 'missing');
  prepare?.(seedDir);
  const r = spawnSync('bash', [boot], {
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      NEKKO_SEED_DIR: seedDir,
      NEKKO_RUNNER_HOME: home,
      NEKKO_SEED_WAIT: '1',
      NEKKO_LOGIN_WAIT: '1',
      NEKKO_POLL: '0.1',
      ...env,
    },
  });
  const log = join(root, 'calls.log');
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status: r.status, calls, out: `${r.stdout}${r.stderr}` };
}

test('plist_runs_the_boot_script_once_as_root', () => {
  const p = readFileSync(plist, 'utf8');
  assert.match(p, /<key>Label<\/key>\s*<string>dev\.nekkolabs\.runner-boot<\/string>/);
  assert.match(p, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/usr\/local\/libexec\/nekko-runner-boot\.sh<\/string>\s*<\/array>/);
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(p, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(p, /<key>StandardOutPath<\/key>\s*<string>\/var\/log\/nekko-runner-boot\.log<\/string>/);
  assert.match(p, /<key>StandardErrorPath<\/key>\s*<string>\/var\/log\/nekko-runner-boot\.log<\/string>/);
  assert.doesNotMatch(p, /UserName|EnvironmentVariables/);
  if (process.platform === 'darwin') assert.equal(spawnSync('plutil', ['-lint', plist]).status, 0);
});

function startsRunSh(calls) {
  const i = calls.findIndex((c) => c.startsWith('launchctl asuser 501 sudo -u runner -H --'));
  assert.ok(i >= 0, calls.join('\n'));
  assert.ok(calls[i].endsWith('/actions-runner/run.sh --jitconfig QUJD'), calls[i]);
  assert.ok(calls.includes('run.sh --jitconfig QUJD'));
  const u = calls.findIndex((c) => c.startsWith('diskutil unmount force'));
  assert.ok(u >= 0 && u < i);
  assert.equal(calls.at(-1), 'shutdown -h now');
}

test('github_seed_starts_run_sh_as_runner_then_shuts_down', () => {
  const { calls, out } = run({ seed: { 'jit-config': 'QUJD' } });
  startsRunSh(calls);
  assert.ok(!existsSync(join(home, '.nekko/jit-config'))); // the copy is gone before the job
  assert.ok(!out.includes('QUJD'), 'the JIT config is never logged');
  assert.match(out, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /m);
});

test('seed_name_is_matched_case_insensitively', () => {
  startsRunSh(run({ seed: { 'JIT-CONFIG': 'QUJD' } }).calls);
});

test('gitlab_seed_runs_single_build_then_shuts_down', () => {
  const { calls } = run({ seed: { 'gitlab-runner.toml': 'concurrent = 1\n' } });
  assert.ok(calls.some((c) => c.endsWith(`/usr/local/bin/gitlab-runner run-single -c ${home}/.nekko/gitlab-runner.toml -r nekko --max-builds 1`)), calls.join('\n'));
  assert.equal(readFileSync(join(home, '.nekko/gitlab-runner.toml'), 'utf8'), 'concurrent = 1\n');
  assert.equal(statSync(join(home, '.nekko/gitlab-runner.toml')).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, '.nekko')).mode & 0o777, 0o700);
  assert.ok(calls.includes(`chown -R runner ${home}/.nekko`));
  assert.equal(calls.at(-1), 'shutdown -h now');
});

test('runner_failure_still_shuts_down', () => {
  const { calls, out } = run({ seed: { 'jit-config': 'QUJD' }, env: { FAKE_EXIT: '3' } });
  assert.ok(calls.includes('run.sh --jitconfig QUJD'));
  assert.match(out, /runner exited with 3/);
  assert.equal(calls.at(-1), 'shutdown -h now');
});

test('unexpected_seed_contents_shut_down_without_running', () => {
  const cases = [
    {},
    { 'jit-config': 'a', 'gitlab-runner.toml': 'b' },
    { other: 'a' },
    { '.hidden': 'a', 'jit-config': 'b' },
    { 'jit-config': 'x'.repeat(65537) },
    { 'jit-config': '' },
  ];
  const check = ({ calls, out }) => {
    assert.ok(!calls.some((c) => c.startsWith('launchctl')), calls.join('\n'));
    assert.match(out, /unexpected seed contents/);
    assert.equal(calls.at(-1), 'shutdown -h now');
  };
  for (const s of cases) check(run({ seed: s }));
  // A symlink named jit-config pointing outside the seed; and a directory with that name.
  for (const make of [
    (s) => {
      writeFileSync(join(root, 'secret'), 'QUJD');
      symlinkSync(join(root, 'secret'), join(s, 'jit-config'));
    },
    (s) => mkdirSync(join(s, 'jit-config')),
  ]) check(run({ seed: {}, prepare: make }));
});

test('the 64 KiB limit is inclusive', () => {
  const { calls } = run({ seed: { 'jit-config': 'x'.repeat(65536) } });
  assert.ok(calls.some((c) => c.startsWith('launchctl asuser 501')));
});

test('no_seed_stays_up_and_runs_nothing', () => {
  const { status, calls, out } = run();
  assert.equal(status, 0);
  assert.ok(calls.includes('diskutil mount readOnly NEKKOSEED'));
  assert.ok(!calls.some((c) => c.startsWith('launchctl') || c.startsWith('shutdown')));
  assert.match(out, /no seed: no runner, staying up/);
});

test('no_login_shuts_down_without_running', () => {
  const { calls, out } = run({ seed: { 'jit-config': 'QUJD' }, env: { FAKE_CONSOLE: 'root' } });
  assert.ok(!calls.some((c) => c.startsWith('launchctl')));
  assert.match(out, /runner user never logged in/);
  assert.equal(calls.at(-1), 'shutdown -h now');
  assert.ok(!existsSync(join(home, '.nekko/jit-config')), 'the credential does not outlive a run that never started');
});

test('scripts_pass_shellcheck', (t) => {
  const files = ['nekko-runner-boot.sh', 'provision.sh'].map((f) => join(dir, f)).filter((f) => existsSync(f));
  const r = spawnSync('shellcheck', files);
  if (r.error?.code === 'ENOENT') return t.skip('shellcheck not installed'); // ubuntu-latest ships it
  assert.equal(r.status, 0, r.stdout.toString());
});

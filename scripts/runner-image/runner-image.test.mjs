import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  // The fake job records whether the seed copy still exists while it runs, and with FAKE_HOSTILE
  // swaps ~/.nekko for a symlink to a victim directory the root-owned cleanup must not touch.
  const victim = join(root, 'victim');
  writeFileSync(
    join(home, 'actions-runner/run.sh'),
    `#!/bin/bash
echo "run.sh $*" >> '${log}'
if [ -e '${home}/.nekko/jit-config' ]; then echo "run.sh saw jit-config" >> '${log}'; fi
if [ -n "\${FAKE_HOSTILE:-}" ]; then
  mkdir -p '${victim}' && echo keep > '${victim}/jit-config' && echo keep > '${victim}/gitlab-runner.toml'
  rm -rf '${home}/.nekko' && ln -s '${victim}' '${home}/.nekko'
fi
exit "\${FAKE_EXIT:-0}"
`,
    { mode: 0o755 },
  );
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
  assert.ok(!calls.includes('run.sh saw jit-config'), 'the copy is gone before the job starts');
  assert.ok(!out.includes('QUJD'), 'the JIT config is never logged');
  assert.match(out, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /m);
});

test('cleanup_never_follows_a_job_controlled_path', () => {
  run({ seed: { 'jit-config': 'QUJD' }, env: { FAKE_HOSTILE: '1' } });
  assert.equal(readFileSync(join(root, 'victim/jit-config'), 'utf8'), 'keep\n');
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

const provision = () => readFileSync(join(dir, 'provision.sh'), 'utf8');

test('provision_pins_official_downloads', () => {
  const p = provision();
  const pin = (name) => p.match(new RegExp(`^${name}=["']?([^"'\\s]+)["']?$`, 'm'))?.[1];
  assert.match(pin('RUNNER_SHA256') ?? '', /^[0-9a-f]{64}$/);
  assert.match(pin('GITLAB_RUNNER_SHA256') ?? '', /^[0-9a-f]{64}$/);
  assert.match(pin('RUNNER_VERSION') ?? '', /^\d+\.\d+\.\d+$/);
  const gitlab = pin('GITLAB_RUNNER_VERSION') ?? '';
  assert.match(gitlab, /^\d+\.\d+\.\d+$/);
  const [major, minor] = gitlab.split('.').map(Number);
  assert.ok(major > 17 || (major === 17 && minor >= 1), `gitlab-runner ${gitlab} is older than 17.1`);
  const lines = p.split('\n');
  const curls = lines.map((l, i) => [l, i]).filter(([l]) => /^\s*curl\b/.test(l));
  assert.equal(curls.length, 2, 'one download each');
  for (const [line, i] of curls) {
    const url = line.match(/https?:\/\/\S+/)?.[0] ?? '';
    assert.ok(
      url.startsWith('https://github.com/actions/runner/releases/download/') ||
        url.startsWith('https://gitlab-runner-downloads.s3.amazonaws.com/'),
      url,
    );
    assert.match(lines[i + 1] ?? '', /shasum -a 256 -c/, `no hash check right after: ${line}`);
  }
});

// The one line allowed to name NOPASSWD: step 9's fatal check.
const NOPASSWD_CHECK = "if grep -v '^[[:space:]]*#' /etc/sudoers | grep NOPASSWD >/dev/null; then";

// Every way the script could hand runner root, a credential or a printed password.
function lockdownProblems(text) {
  const lines = text.split('\n').filter((l) => !/^\s*#/.test(l));
  const bad = [];
  const flag = (why, test) => {
    for (const l of lines) if (test(l)) bad.push(`${why}: ${l.trim()}`);
  };
  flag('NOPASSWD', (l) => l.includes('NOPASSWD') && l.trim() !== NOPASSWD_CHECK);
  flag('writes sudoers', (l) => /sudoers/.test(l) && l.trim() !== NOPASSWD_CHECK && (/>|\btee\b|\bvisudo\b|\bcp\b|\bmv\b|\binstall\b|\bln\b/.test(l)));
  flag('runner admin', (l) => /\bdseditgroup\b[^\n]*\badmin\b/.test(l) || /-append\s+\/Groups\/admin/.test(l));
  flag('runner admin', (l) => /\brunner\b/.test(l) && (/GroupMembership/.test(l) || /(^|\s)-admin\b/.test(l)));
  flag('registers', (l) => l.includes('--jitconfig') || l.includes('config.sh'));
  flag('prints a password', (l) => /\b(echo|printf)\b.*\$\{?\w*(pass|pw)\w*/i.test(l));
  // Found by the T214 VM boot check: each one fails silently on macOS 15.
  flag('dscl -passwd cannot reset a secure-token admin', (l) => /\bdscl\b.*-passwd\b/.test(l));
  flag('sysadminctl -autologin writes nothing', (l) => /\bsysadminctl\b.*-autologin\b/.test(l));
  flag('softwareupdate --schedule off changes nothing', (l) => /\bsoftwareupdate\b.*--schedule\b/.test(l));
  // Found building the macOS 26 image: it needs Full Disk Access, fails and stops the build.
  flag('systemsetup -setremotelogin needs Full Disk Access', (l) => /\bsystemsetup\b.*-setremotelogin\b/.test(l));
  return bad;
}

test('provision_locks_the_guest_down', () => {
  const p = provision();
  for (const s of [
    'launchctl disable system/com.openssh.sshd',
    'disabled_services="$(launchctl print-disabled system)"',
    'for s in com.openssh.sshd com.apple.screensharing; do',
    '[[ "$disabled_services" == *"\\"$s\\" => disabled"* ]] || die ',
    'launchctl disable system/com.apple.screensharing',
    'ARDAgent.app/Contents/Resources/kickstart',
    '"$kickstart" -deactivate -stop',
    'org.cirruslabs',
    '/etc/sudoers.d',
    'defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser runner',
    'chmod 0600 /etc/kcpassword',
    'pwpolicy -u "$u" -disableuser',
    '[[ "$(pwpolicy -u "$u" -authentication-allowed 2>&1)" == *"not allowed to authenticate"* ]] || die ',
    '[[ "$(pwpolicy -u root -authentication-allowed 2>&1)" == *"not allowed to authenticate"* ]] || die ',
    'm="$(dsmemberutil checkmembership -U "$u" -G admin 2>&1 || true)"',
    '*) die "cannot tell whether $u is an admin',
    '[ "$u" != runner ] || die ',
    'users="$(dscl . -list /Users)"',
    '[ -n "$users" ] || die ',
    'done <<<"$users"',
    '[ "$disabled" -gt 0 ] || die ',
    '[ "$(fdesetup status 2>&1)" = "FileVault is Off." ] || die ',
    '/usr/local/libexec/nekko-runner-boot.sh',
    '/Library/LaunchDaemons/dev.nekkolabs.runner-boot.plist',
  ])
    assert.ok(p.includes(s), s);
  assert.ok(p.includes(`${NOPASSWD_CHECK}\n  die `), 'the NOPASSWD check is fatal');
  assert.ok(p.split('\n').some((l) => l.includes('sysadminctl -addUser runner')), 'creates the runner user');
  assert.deepEqual(lockdownProblems(p), []);
});

test('provision_verifies_runner_has_no_sudo_and_no_admin', () => {
  const p = provision();
  assert.match(p, /sudo_l="\$\(sudo -l -U runner 2>&1 \|\| true\)"\n\[\[ "\$sudo_l" == \*"is not allowed to run sudo"\* \]\] \|\| die /);
  assert.match(p, /membership="\$\(dsmemberutil checkmembership -U runner -G admin 2>&1 \|\| true\)"\n\[\[ "\$membership" == \*"is not a member"\* \]\] \|\| die /);
});

test('lockdown_bans_trip_on_planted_lines', () => {
  const p = provision();
  for (const line of [
    'echo "runner ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/runner',
    'grep -q x /etc/hosts && echo NOPASSWD',
    'echo "runner ALL=(ALL) ALL" | tee -a /etc/sudoers',
    'cp ./extra /etc/sudoers.d/extra',
    'EDITOR=true visudo -f /etc/sudoers',
    'dseditgroup -o edit -a runner -t user admin',
    'dscl . -append /Groups/admin GroupMembership runner',
    'sysadminctl -addUser runner -fullName "CI runner" -admin',
    'sysadminctl -adminUser x -adminPassword y; sysadminctl -edit runner -admin',
    'sudo -u runner "$runner_home/actions-runner/config.sh" --unattended',
    'dscl . -passwd "/Users/$u" "$pw"',
    'sysadminctl -autologin set -userName runner -password "$runner_pw"',
    'softwareupdate --schedule off',
    'systemsetup -f -setremotelogin off',
    'echo "$runner_pw"',
  ])
    assert.notDeepEqual(lockdownProblems(`${p}\n${line}\n`), [], line);
});

// Cirrus images link /Users/runner to the admin's home (found by the T214 VM boot check):
// creating runner over that link would hand it the admin's home.
test('provision_replaces_the_runner_home_link', () => {
  const p = provision();
  const at = (s) => {
    const i = p.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };
  const refuse = at('if [ -e "$runner_home" ] && [ ! -L "$runner_home" ]; then\n  die ');
  const unlink = at('if [ -L "$runner_home" ]; then\n  rm "$runner_home"\nfi');
  const add = at('sysadminctl -addUser runner');
  assert.ok(refuse < at('# 2. The job user'), 'refuses a real home in the preflight');
  assert.ok(unlink < add, 'removes the link before creating the user');
});

// The T214 VM boot check found sysadminctl -autologin writes nothing on macOS 15, so the script
// writes /etc/kcpassword itself. "admin" checked against the kcpassword in Cirrus's base image.
test('provision_writes_kcpassword_in_apples_format', () => {
  const fn = provision().match(/^kcpassword\(\) \{[\s\S]*?^\}$/m)?.[0];
  assert.ok(fn, 'kcpassword function');
  const kc = (pw) => execFileSync('/bin/bash', ['-c', `${fn}\nkcpassword "$1"`, '_', pw]).toString('hex');
  assert.equal(kc('admin'), '1ced3f4abcbcddeaa3b91f7d');
  // Unverified on a real Mac: whether a 12-character password needs an extra NUL block.
  assert.equal(kc('a'.repeat(32)).length, 72);
});

test('provision_turns_off_automatic_updates', () => {
  const p = provision();
  for (const key of ['AutomaticCheckEnabled', 'AutomaticDownload', 'CriticalUpdateInstall', 'ConfigDataInstall', 'AutomaticallyInstallMacOSUpdates'])
    assert.ok(p.includes(`defaults write /Library/Preferences/com.apple.SoftwareUpdate ${key} -bool false\n`), key);
});

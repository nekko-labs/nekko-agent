// The Linux guest's boot script (nekko-runner-boot.sh) and provision script, run on the host with
// every system command stubbed: no VM, no root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = 'scripts/runner-image/linux';
const boot = join(dir, 'nekko-runner-boot.sh');
const provision = readFileSync(join(dir, 'provision.sh'), 'utf8');

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'linux-runner-image-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const seed = join(root, 'seed');
  const proc = join(root, 'proc');
  const dev = join(root, 'dev');
  for (const d of [bin, join(home, 'actions-runner'), seed, proc, dev]) mkdirSync(d, { recursive: true });
  const log = join(root, 'calls.log');
  const stub = (name, body = '') =>
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  stub('blkid');
  stub('mount');
  stub('umount');
  stub('chown');
  stub('poweroff');
  // GNU stat's `-c %Y`, as the guest has: a seed written "now" on the Mac.
  stub('stat', 'echo "${FAKE_SEED_SECS:-4000000000}"');
  stub('date', 'case "$1" in -s) ;; +%s) echo 1700000000 ;; *) /bin/date "$@" ;; esac');
  // runuser -u runner -- env -i ... cmd: run cmd as is, only inside the temp root.
  stub('runuser', `shift 3; [ "$1" = env ] && shift 6; case "$1" in ./*|'${root}'/*) exec "$@";; esac`);
  writeFileSync(
    join(home, 'actions-runner/run.sh'),
    `#!/bin/bash\necho "run.sh $*" >> '${log}'\nsleep "\${FAKE_SLEEP:-0}"\nexit "\${FAKE_RC:-0}"\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(proc, 'stat'), 'cpu  100 0 100 600 200 0 0 0 0 0\ncpu0 1 1 1 1 1 0 0 0 0 0\n');
  writeFileSync(join(proc, 'meminfo'), 'MemTotal:        4096000 kB\nMemFree:          100000 kB\nMemAvailable:    3072000 kB\n');
  writeFileSync(join(proc, 'vmstat'), 'pswpin 0\npswpout 512\n');
  return { root, bin, home, seed, proc, dev, log };
}

function runBoot(r, env = {}) {
  const res = spawnSync('bash', [boot], {
    encoding: 'utf8',
    env: {
      PATH: `${r.bin}:/usr/bin:/bin`,
      NEKKO_SEED_DIR: r.seed,
      NEKKO_RUNNER_HOME: r.home,
      NEKKO_SEED_WAIT: '1',
      NEKKO_POLL: '0.1',
      NEKKO_PROC: r.proc,
      NEKKO_DEV_GLOB: `${r.dev}/vd*`,
      NEKKO_STATS_EVERY: '0.2',
      NEKKO_POWEROFF: 'poweroff',
      ...env,
    },
  });
  // The log's own timestamps are not calls worth asserting on.
  const calls = existsSync(r.log) ? readFileSync(r.log, 'utf8').trim().split('\n').map((c) => c.trim()).filter((c) => !/^date (-u|\+%s)/.test(c)) : [];
  return { ...res, calls };
}

test('a_github_seed_runs_run_sh_once_then_powers_off', () => {
  const r = rig();
  writeFileSync(join(r.seed, 'jit-config'), 'QUJD\n');
  const { stdout, calls } = runBoot(r);
  assert.ok(calls.includes('run.sh --jitconfig QUJD'), calls.join('\n'));
  assert.equal(calls.at(-1), 'poweroff');
  assert.match(stdout, /runner exited with 0/);
  assert.ok(!existsSync(join(r.home, '.nekko', 'jit-config')), 'the seed copy is gone before the job');
});

test('the_clock_moves_forward_to_the_seed_never_back', () => {
  const r = rig();
  writeFileSync(join(r.seed, 'jit-config'), 'QUJD\n');
  assert.ok(runBoot(r).calls.includes('date -s @4000000000'));
  const back = rig();
  writeFileSync(join(back.seed, 'jit-config'), 'QUJD\n');
  assert.ok(!runBoot(back, { FAKE_SEED_SECS: '1600000000' }).calls.some((c) => c.startsWith('date -s')));
});

test('usage_samples_land_after_the_stats_header', () => {
  const r = rig();
  writeFileSync(join(r.seed, 'jit-config'), 'QUJD\n');
  const disk = join(r.dev, 'vdd');
  const blank = Buffer.alloc(64 * 1024);
  blank.write('NEKKOSTATS1');
  writeFileSync(disk, blank);
  writeFileSync(join(r.dev, 'vdc'), Buffer.alloc(4096));
  runBoot(r, { FAKE_SLEEP: '1.5' });
  const body = readFileSync(disk).subarray(512).toString('utf8').replace(/\0+$/, '').trim();
  const first = body.split('\n')[0].split(' ');
  // 4,096,000 kB total, 3,072,000 available: 1000 MB used; 512 pages swapped out: 2 MB.
  assert.equal(first.length, 5, body);
  assert.deepEqual(first.slice(2), ['1000', '0', '2']);
  assert.ok(Number(first[1]) >= 0 && Number(first[1]) <= 100, body);
  assert.equal(readFileSync(join(r.dev, 'vdc')).toString('utf8').replace(/\0/g, ''), '', 'other disks untouched');
});

test('the_test_seed_powers_off_without_a_runner', () => {
  const r = rig();
  writeFileSync(join(r.seed, 'nekko-test'), 'test\n');
  const { stdout, calls } = runBoot(r);
  assert.match(stdout, /test seed: the image boots/);
  assert.ok(!calls.some((c) => c.startsWith('run.sh')));
  assert.equal(calls.at(-1), 'poweroff');
});

test('unexpected_seeds_run_nothing_and_power_off', () => {
  for (const files of [['jit-config', 'extra'], ['evil.sh']]) {
    const r = rig();
    for (const f of files) writeFileSync(join(r.seed, f), 'x\n');
    const { stdout, calls } = runBoot(r);
    assert.match(stdout, /unexpected seed contents/, files.join());
    assert.ok(!calls.some((c) => c.startsWith('run.sh')));
    assert.equal(calls.at(-1), 'poweroff');
  }
});

test('no_seed_stays_up', () => {
  const r = rig();
  const { stdout, calls } = runBoot(r);
  assert.match(stdout, /no seed: no runner, staying up/);
  assert.ok(!calls.includes('poweroff'));
});

test('provision_pins_and_checks_its_downloads', () => {
  for (const name of ['RUNNER_SHA256', 'GITLAB_RUNNER_SHA256']) assert.match(provision, new RegExp(`^${name}=[0-9a-f]{64}$`, 'm'));
  assert.equal((provision.match(/sha256sum -c/g) ?? []).length, 2);
  const mac = readFileSync('scripts/runner-image/provision.sh', 'utf8');
  for (const v of ['RUNNER_VERSION', 'GITLAB_RUNNER_VERSION']) {
    assert.equal(provision.match(new RegExp(`^${v}=(.*)$`, 'm'))[1], mac.match(new RegExp(`^${v}=(.*)$`, 'm'))[1], `${v} matches the macOS image`);
  }
});

test('provision_turns_off_what_a_job_vm_must_not_have', () => {
  for (const s of ['openssh-server', 'unattended-upgrades', 'cloud-init.disabled', 'truncate -s 0 /etc/machine-id', 'userdel -r ubuntu']) {
    assert.ok(provision.includes(s), s);
  }
  assert.ok(provision.includes('NEKKO-PROVISION-OK') && provision.includes('NEKKO-PROVISION-FAILED'));
});

test('linux_scripts_pass_shellcheck', (t) => {
  const r = spawnSync('shellcheck', [boot, join(dir, 'provision.sh')], { encoding: 'utf8' });
  if (r.error) return t.skip('no shellcheck');
  assert.equal(r.status, 0, r.stdout);
});

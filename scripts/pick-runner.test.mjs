import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, pick } from './pick-runner.mjs';

const r = (o = {}) => ({ status: 'online', busy: false, labels: [{ name: 'self-hosted' }, { name: 'macOS' }, { name: 'ARM64' }, { name: 'nekko-mac' }], ...o });

test('online_idle_runner_with_the_label_is_chosen', () =>
  assert.equal(pick([r({ busy: true }), r()], 'nekko-mac', 'macos-latest'), '["self-hosted","nekko-mac"]'));

test('busy_offline_or_unlabelled_falls_back', () => {
  for (const rs of [[], [r({ busy: true })], [r({ status: 'offline' })], [r({ labels: [{ name: 'self-hosted' }] })]])
    assert.equal(pick(rs, 'nekko-mac', 'macos-latest'), '"macos-latest"');
});

test('main_without_a_token_never_calls_the_api', async () => {
  let called = false;
  assert.equal(await main({ PICK_REPO: 'nekko-labs/nekko-agent' }, async () => { called = true; }), '"macos-latest"');
  assert.equal(called, false);
});

test('main_falls_back_on_every_failure', async () => {
  const env = { PICK_TOKEN: 't', PICK_REPO: 'nekko-labs/nekko-agent', PICK_FALLBACK: 'macos-14' };
  for (const f of [async () => new Response('', { status: 500 }), async () => new Response('', { status: 403 }),
                   async () => { throw new Error('down'); }, async () => new Response('not json'),
                   async () => new Response('{"total_count":0}')])
    assert.equal(await main(env, f), '"macos-14"');
  assert.equal(await main({ ...env, PICK_LABEL: 'bad label' }, async () => assert.fail('called')), '"macos-14"');
});

test('main_asks_the_repo_runners_api', async () => {
  const seen = [];
  const out = await main({ PICK_TOKEN: 'secret', PICK_REPO: 'nekko-labs/nekko-agent' },
    async (url, init) => { seen.push([url, init.headers.Authorization]); return Response.json({ runners: [r()] }); });
  assert.equal(out, '["self-hosted","nekko-mac"]');
  assert.deepEqual(seen, [['https://api.github.com/repos/nekko-labs/nekko-agent/actions/runners?per_page=100', 'Bearer secret']]);
});

test('main_in_org_mode_asks_the_org_runners_api', async () => {
  const seen = [];
  const out = await main({ PICK_TOKEN: 'secret', PICK_REPO: 'nekko-labs/nekko-agent', PICK_ORG: 'nekko-labs' },
    async (url) => { seen.push(url); return Response.json({ runners: [r()] }); });
  assert.equal(out, '["self-hosted","nekko-mac"]');
  assert.deepEqual(seen, ['https://api.github.com/orgs/nekko-labs/actions/runners?per_page=100']);
});

test('main_in_org_mode_falls_back_on_403_and_bad_org', async () => {
  const env = { PICK_TOKEN: 't', PICK_REPO: 'nekko-labs/nekko-agent', PICK_ORG: 'nekko-labs', PICK_FALLBACK: 'macos-14' };
  assert.equal(await main(env, async () => new Response('{"message":"Resource not accessible"}', { status: 403 })), '"macos-14"');
  assert.equal(await main({ ...env, PICK_ORG: 'a/b' }, async () => assert.fail('called')), '"macos-14"');
});

test('cli_writes_runs_on_and_never_prints_the_token', () => {
  const script = new URL('./pick-runner.mjs', import.meta.url).pathname;
  const run = (extra) => {
    const out = join(mkdtempSync(join(tmpdir(), 'pick-')), 'out');
    const p = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, PICK_REPO: 'a/b', ...extra }, encoding: 'utf8' });
    return { p, out: readFileSync(out, 'utf8') };
  };
  let { p, out } = run({ PICK_TOKEN: '' });
  assert.equal(p.status, 0);
  assert.equal(out, 'runs-on="macos-latest"\n');
  ({ p, out } = run({ PICK_TOKEN: 'tok-123', GITHUB_API_URL: 'http://127.0.0.1:9' }));
  assert.equal(p.status, 0);
  assert.equal(out, 'runs-on="macos-latest"\n');
  assert.ok(!(p.stdout + p.stderr).includes('tok-123'));
});

const pickBlock = (y) => y.match(/\n  pick:\n(?:.*\n)*?  protocol-and-build:/)[0];

test('ios_native_calls_the_picker_only_for_trusted_events', () => {
  const y = readFileSync(new URL('../.github/workflows/ios-native.yml', import.meta.url), 'utf8');
  const pickIf = y.match(/\n  pick:\n(?:.*\n)*?    if: (.*)\n/)[1];
  assert.match(pickIf, /^vars\.NEKKO_MAC_RUNNERS == 'on' && /);
  // Only refs the runner group allows; a labeled PR always runs hosted.
  assert.match(pickIf, /\(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)/);
  assert.match(pickIf, /\(github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/ci\/ios-batch'\)/);
  assert.doesNotMatch(pickIf, /pull_request/);
  assert.match(pickBlock(y), /org: \$\{\{ vars\.NEKKO_MAC_RUNNER_ORG \}\}/);
  assert.match(pickBlock(y), /\n    continue-on-error: true\n/);
  assert.match(y, /token: \$\{\{ secrets\.NEKKO_PICKER_TOKEN \}\}/);
  assert.match(y, /runs-on: \$\{\{ fromJSON\(needs\.pick\.outputs\.runs-on \|\| '"xcode-27"'\) \}\}/);
  assert.match(y, /needs: pick\n    # .*\n    if: \$\{\{ !cancelled\(\) && /);
});

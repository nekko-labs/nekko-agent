import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('CI cancels stale PR revisions without cancelling main runs', () => {
  const ci = read('../.github/workflows/ci.yml');
  assert.ok(ci.includes('group: ci-${{ github.event.pull_request.number || github.run_id }}'));
  assert.ok(ci.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
});

test('a bot merge dispatches full CI on main, since GITHUB_TOKEN merges start no push run', () => {
  const merge = read('../.github/workflows/auto-merge.yml');
  assert.ok(merge.includes('gh workflow run ci.yml --repo "$GH_REPO" --ref main'));
  assert.match(read('../.github/workflows/ci.yml'), /\n  workflow_dispatch:\n/);
});

test('required build restores a dedicated Rust cache before compiling', () => {
  const build = read('../.github/workflows/ci.yml').split('\n  build:')[1].split('\n  daemon:')[0];
  assert.ok(build.indexOf('Swatinem/rust-cache@v2') < build.indexOf('cargo build -p nekkod --locked'));
  assert.ok(build.includes('shared-key: ci-build'));
  for (const command of ['npm run build:web', 'npm test', 'npm run test:cli-package', 'npm run typecheck']) {
    assert.ok(build.includes(`- run: ${command}`));
  }
});

test('Docker images cannot overwrite each other\'s BuildKit cache scope', () => {
  const docker = read('../.github/workflows/docker.yml');
  for (const scope of ['agent-image', 'relay-image']) {
    assert.ok(docker.includes(`cache-from: type=gha,scope=${scope}`));
    assert.ok(docker.includes(`cache-to: type=gha,mode=max,scope=${scope}`));
  }
});

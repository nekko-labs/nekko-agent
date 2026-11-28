import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { attributionViolations } from './check-git-attribution.mjs';

const commit = message => ({ sha: '123456789abcdef', commit: { message } });

test('the shared settings disable all three attribution fields', () => {
  const settings = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  assert.deepEqual(settings.attribution, { commit: '', pr: '', sessionUrl: false });
});

test('flags default Claude trailers, PR footers and cloud session links', () => {
  assert.deepEqual(attributionViolations({
    title: 'Chat: quieter replies',
    body: 'Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  }, [commit('Fix chat\n\nCo-authored-by: Claude Opus 4.6 <noreply@anthropic.com>')]), ['PR body', 'commit 123456789abc']);
  assert.deepEqual(attributionViolations({ title: 'Generated with Claude Code', body: null }, [
    commit('Fix tests\n\nhttps://claude.ai/code/session_abc'),
  ]), ['PR title', 'commit 123456789abc']);
});

test('preserves provider references, quoted examples and human trailers', () => {
  assert.deepEqual(attributionViolations({
    title: 'Claude Agent: preserve provider metadata',
    body: 'Keep Claude Code as a provider.\n> Generated with Claude Code\n[Claude Code docs](https://code.claude.com/docs)',
  }, [commit('Update provider docs\n\nCo-authored-by: Claude Martin <claude@human.example>\nSigned-off-by: Dev <dev@example.org>')]), []);
});

test('commit-msg hook rejects generated attribution and accepts ordinary messages', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), 'nekko-attribution-'));
  try {
    const message = join(temp, 'message');
    const check = () => spawnSync('sh', ['.githooks/commit-msg', message], { cwd: root, encoding: 'utf8' });
    writeFileSync(message, 'Update Claude Code provider docs\n');
    assert.equal(check().status, 0);
    writeFileSync(message, 'Update provider docs\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /commit message/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

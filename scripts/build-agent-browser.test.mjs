import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

test('target-only cache is overlaid with a real pinned checkout without losing build products', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-native-cache-test-'));
  try {
    const upstream = join(dir, 'upstream');
    const source = join(dir, 'source');
    const git = (args, cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', upstream]);
    writeFileSync(join(upstream, 'pin.txt'), 'pinned');
    git(['add', '.'], upstream);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], upstream);
    mkdirSync(join(source, 'cli/target'), { recursive: true });
    writeFileSync(join(source, 'cli/target/cache-sentinel'), 'cached');
    const build = readFileSync(new URL('./build-agent-browser.mjs', import.meta.url), 'utf8');
    const block = build.slice(build.indexOf("if (!existsSync(join(source, '.git')))"), build.indexOf("if (git(['rev-parse', 'HEAD'], source)"));
    assert.ok(block.length > 0);
    new Function('source', 'upstream', 'existsSync', 'join', 'mkdtempSync', 'dirname', 'git', 'cpSync', 'rmSync', block)(source, upstream, existsSync, join, mkdtempSync, dirname, git, cpSync, rmSync);
    assert.equal(git(['rev-parse', 'HEAD'], source), git(['rev-parse', 'HEAD'], upstream));
    assert.equal(readFileSync(join(source, 'cli/target/cache-sentinel'), 'utf8'), 'cached');
    assert.equal(readFileSync(join(source, 'pin.txt'), 'utf8'), 'pinned');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

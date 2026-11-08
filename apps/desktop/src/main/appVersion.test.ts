import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopVersion } from './appVersion.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-version-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Version test');
  git('config', 'user.email', 'version@example.invalid');
  git('commit', '--allow-empty', '-m', 'initial');
  const read = () => desktopVersion({ isPackaged: false, version: '0.8.2', appPath: dir });
  return { dir, git, read };
}

describe('desktop build identity', () => {
  it('shares one resolved identity with the engine and both launcher outcomes', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain('const appVersion = desktopVersion({ isPackaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath() });');
    expect(source.match(/version: appVersion/g)).toHaveLength(3);
    expect(source.match(/app\.getVersion\(\)/g)).toHaveLength(1);
  });
  it('keeps the stamped installer version without requiring Git', () => {
    expect(desktopVersion({ isPackaged: true, version: '0.9.3', appPath: '/does-not-exist' })).toBe('0.9.3');
  });
  it('uses the newest numeric stable release and source distance, not the manifest', () => {
    const { git, read } = repo();
    git('tag', 'v0.9.2');
    git('tag', 'v0.9.10');
    git('tag', 'v1.0.0-rc.1');
    git('tag', 'nightly/desktop/v0.9.99');
    git('tag', 'pr-media-99');
    git('commit', '--allow-empty', '-m', 'new code');
    expect(read()).toBe(`0.9.10-dev.1+g${git('rev-parse', '--short=8', 'HEAD')}`);
  });
  it('normalizes short release tags and still identifies an unpackaged build at a release commit', () => {
    const { git, read } = repo();
    git('tag', 'v0.10');
    expect(read()).toMatch(/^0\.10\.0-dev\.0\+g[0-9a-f]+$/);
  });
  it('does not claim a release from an unrelated branch', () => {
    const { git, read } = repo();
    git('tag', 'v0.9.1');
    git('checkout', '-b', 'future');
    git('commit', '--allow-empty', '-m', 'future');
    git('tag', 'v5.0.0');
    git('checkout', 'main');
    expect(read()).toMatch(/^0\.9\.1-dev\.0\+g/);
  });
  it('marks tracked local edits but ignores untracked scratch files', () => {
    const { dir, git, read } = repo();
    writeFileSync(join(dir, 'source'), 'before');
    git('add', 'source');
    git('commit', '-m', 'source');
    git('tag', 'v0.9.1');
    writeFileSync(join(dir, 'scratch'), 'untracked');
    expect(read()).not.toContain('dirty');
    writeFileSync(join(dir, 'source'), 'after');
    expect(read()).toMatch(/\.dirty$/);
  });
  it('labels a checkout without tags as development', () => {
    expect(repo().read()).toMatch(/^0\.8\.2-dev\.1\+g/);
  });
  it('labels unavailable source identity explicitly without preventing launch', () => {
    expect(desktopVersion({ isPackaged: false, version: '0.8.2', appPath: '/does-not-exist' })).toBe('0.8.2-dev.unknown');
  });
});

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What electron-updater decides, recorded from its own code so the Rust
 * updater (crates/nekko-native) is held to it: node-semver as electron-updater
 * bundles it (parse and the newer-than check), `parseUpdateInfo` +
 * `resolveFiles` over every `latest*.yml` published for past releases
 * (tests/fixtures/feeds, from `gh release download`), and which file each
 * platform's updater downloads (`findFile`, `MacUpdater.filterFilesForArch`).
 * Fails when the golden file is stale; rewrite it with `UPDATE_GOLDEN=1`.
 */
const require = createRequire(import.meta.url);
const updaterDir = resolve(require.resolve('electron-updater'), '..');
const semver = require(require.resolve('semver', { paths: [updaterDir] }));
const { parseUpdateInfo, resolveFiles, findFile } = require(join(updaterDir, 'providers/Provider.js'));
const { newUrlFromBase } = require(join(updaterDir, 'util.js'));

const crate = resolve(__dirname, '../../../../crates/nekko-native/tests');
const feeds = join(crate, 'fixtures/feeds');
const golden = join(crate, 'golden/updater.json');

const VERSIONS = [
  '0.8.1', 'v0.8.1', ' 0.8.1 ', '0.8', '0.8.1.2', '01.0.0', '0.08.1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta',
  '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.0+build.7', '1.0.0-01', '1.0.0-0a', '1.0.0-', '1.0.0+',
  '9007199254740991.0.0', '9007199254740992.0.0', '1.0.0-9007199254740992', '=1.0.0', 'V1.0.0', '1.0.0-x.7.z.92',
  '', 'latest', '0.9.0-beta', '0.10.0', '10.0.0',
];
const PAIRS: [string, string][] = [
  ['0.8.1', '0.8.1'], ['0.8.1', '0.8.2'], ['0.8.1', '0.9.0'], ['0.8.1', '0.8.0'], ['0.9.0', '0.10.0'], ['0.8.1', '0.9.0-beta'],
  ['0.9.0-beta', '0.9.0'], ['0.9.0-beta.2', '0.9.0-beta.11'], ['0.9.0-alpha', '0.9.0-beta'], ['1.0.0', '1.0.0+build'],
  ['0.8.1', 'not-a-version'], ['0.8.1', 'v0.9.0'], ['1.0.0-alpha.beta', '1.0.0-alpha.1'], ['1.0.0-rc.1', '1.0.0-rc.1'],
  ['2.0.0', '10.0.0'], ['0.8.1', '9007199254740992.0.0'],
];

function arch(file: { url: URL; info: { url: string } }, a: string) { return [file.url.pathname, file.info.url].some(n => n.includes(a)); }
// findFile reads process.arch; pass it in explicitly instead.
function pick(files: any[], ext: string, not: string[] | undefined, a: string) {
  const original = process.arch;
  Object.defineProperty(process, 'arch', { value: a, configurable: true });
  // An empty list throws "No files provided": recorded as no pick.
  try { return findFile(files, ext, not); } catch { return null; } finally { Object.defineProperty(process, 'arch', { value: original, configurable: true }); }
}
function macFilter(files: any[], arm64: boolean) {
  const isArm = (f: any) => arch(f, 'arm64');
  if (arm64 && files.some(isArm)) return files.filter(f => arm64 === isArm(f));
  return files.filter(f => !isArm(f));
}

function build() {
  const versions = VERSIONS.map(v => ({ input: v, parsed: semver.valid(v) }));
  const compares = PAIRS.map(([current, latest]) => {
    const l = semver.parse(latest);
    return { current, latest, available: l == null ? null : semver.gt(l, semver.parse(current)) };
  });
  const feedCases: unknown[] = [];
  for (const tag of readdirSync(feeds).sort()) {
    for (const name of readdirSync(join(feeds, tag)).sort()) {
      const text = readFileSync(join(feeds, tag, name), 'utf8');
      const info = parseUpdateInfo(text, name, 'x');
      const base = new URL('https://github.com');
      const resolved = resolveFiles(info, base, (p: string) => `/nekko-labs/nekko-agent/releases/download/${tag}/${p.replace(/ /g, '-')}`);
      const generic = resolveFiles(info, new URL('http://127.0.0.1:4599/feed/'));
      const picks: Record<string, string | null> = {};
      for (const a of ['x64', 'arm64']) {
        picks[`win-${a}`] = pick(resolved, 'exe', undefined, a)?.url.href ?? null;
        picks[`mac-${a}`] = pick(macFilter(resolved, a === 'arm64'), 'zip', ['pkg', 'dmg'], a)?.url.href ?? null;
        picks[`appimage-${a}`] = pick(resolved, 'AppImage', ['rpm', 'deb', 'pacman'], a)?.url.href ?? null;
        picks[`deb-${a}`] = pick(resolved, 'deb', ['AppImage', 'rpm', 'pacman'], a)?.url.href ?? null;
      }
      feedCases.push({
        tag, file: name, version: info.version, releaseDate: info.releaseDate ?? null,
        files: resolved.map((f: any) => ({ url: f.url.href, sha512: f.info.sha512 ?? null, size: f.info.size ?? null })),
        generic: generic.map((f: any) => f.url.href),
        picks,
      });
    }
  }
  const urls = [
    ['https://github.com', '/o/r/releases/latest'],
    ['http://127.0.0.1:4599/feed/', 'latest.yml'],
    ['http://127.0.0.1:4599/feed/?t=1', 'NekkoAgent-0.9.0-x64.exe'],
  ].map(([base, path]) => ({ base, path, url: newUrlFromBase(path, new URL(base)).href }));
  return { versions, compares, feeds: feedCases, urls };
}

describe('updater golden', () => {
  it('matches what electron-updater decides', () => {
    const text = `${JSON.stringify(build(), null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, text);
    expect(readFileSync(golden, 'utf8').replace(/\r\n/g, '\n')).toBe(text);
  });
});

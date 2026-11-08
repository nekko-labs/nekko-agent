import { execFileSync } from 'node:child_process';

/** Release installers keep their stamped version; local builds identify their actual source. */
export function desktopVersion({ isPackaged, version, appPath }: { isPackaged: boolean; version: string; appPath: string }): string {
  if (isPackaged) return version;
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: appPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  }).trim();
  try {
    // Ignore nightlies, evidence tags and prereleases. Only tags reachable from
    // this checkout describe its release line, not a newer unrelated branch.
    const tags = git('tag', '--merged', 'HEAD').split('\n')
      .filter(tag => /^v\d+\.\d+(?:\.\d+)?$/.test(tag))
      .sort((a, b) => {
        const left = a.slice(1).split('.').map(Number);
        const right = b.slice(1).split('.').map(Number);
        return (right[0] - left[0]) || (right[1] - left[1]) || ((right[2] ?? 0) - (left[2] ?? 0));
      });
    const tag = tags[0];
    const base = tag ? `${tag.slice(1)}${tag.split('.').length === 2 ? '.0' : ''}` : version;
    const commit = git('rev-parse', '--short=8', 'HEAD');
    const count = git('rev-list', '--count', tag ? `${tag}..HEAD` : 'HEAD');
    const dirty = git('status', '--porcelain', '--untracked-files=no') ? '.dirty' : '';
    return `${base}-dev.${count}+g${commit}${dirty}`;
  } catch {
    // Source archives and machines without Git still launch, but must never
    // present a stale manifest number as if this were a released installer.
    return `${version}-dev.unknown`;
  }
}

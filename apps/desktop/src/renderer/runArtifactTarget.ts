import { artifactKind } from './artifactsIndex.js';

/**
 * What clicking a training or goal run's reported artifact opens. A reported
 * path is opened with the system's default app only when it is a document
 * kind the Artifacts tab lists (the same extension check) and it lies inside
 * the run's workspace; anything else (a model file, a folder, an unknown
 * type, a path outside the workspace) opens the run's output folder instead.
 */

function isAbsolutePath(p: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(p);
}

/** Resolve a path relative to the workspace, or keep one that is already absolute. */
export function joinPath(base: string | undefined, rel: string): string {
  if (!base || isAbsolutePath(rel)) return rel;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '')}`;
}

/** Path segments with `.` dropped, or null when `..` would climb above the start. */
function segments(path: string): string[] | null {
  const out: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out;
}

/** Whether `path` (relative to `base`, or absolute) stays inside `base`. */
export function insideWorkspace(base: string | undefined, path: string): boolean {
  if (!base || !path.trim()) return false;
  if (/^[\\/]{2}/.test(path) || /^[\\/]{2}/.test(base)) return false;
  const windows = /^[a-zA-Z]:/.test(base) || base.includes('\\');
  const key = (s: string) => (windows ? s.toLowerCase() : s);
  const root = segments(base);
  const full = segments(joinPath(base, path));
  if (!root || !full || full.length <= root.length) return false;
  return root.every((s, i) => key(s) === key(full[i]));
}

/** The path to open for a reported artifact (see the module comment). */
export function runArtifactTarget(base: string | undefined, rel: string, outDir: string): { path: string; opensFile: boolean } {
  const opensFile = insideWorkspace(base, rel) && artifactKind(rel) !== null;
  return { path: joinPath(base, opensFile ? rel : outDir), opensFile };
}

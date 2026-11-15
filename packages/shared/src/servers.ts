/**
 * The web pages served on this computer (`servers:list`, issue #2824): what
 * the Agents panel's Browsers view lists, so a dev server opens in a browser
 * without an agent. The daemon finds them (crates/nekko-machine/src/servers.rs).
 */

import { folderPathKey } from './workspace.js';

export interface ServedSite {
  /** `http://localhost:5173/`. */
  url: string;
  port: number;
  /** The page's `<title>`, when it has one. */
  title?: string;
  /** The serving process ("node", "python3"). */
  process?: string;
  /** The serving process's working folder. */
  cwd?: string;
}

export interface ServedSites {
  servers: ServedSite[];
}

/**
 * The connected folder a site runs from: the deepest folder holding the
 * serving process's working folder, so a site started inside a repository is
 * tagged with that repository.
 */
export function siteFolder<F extends { path: string }>(site: Pick<ServedSite, 'cwd'>, folders: readonly F[]): F | undefined {
  if (!site.cwd) return undefined;
  const cwd = folderPathKey(site.cwd);
  let best: F | undefined;
  let bestLen = -1;
  for (const f of folders) {
    const root = folderPathKey(f.path);
    if (!root) continue;
    const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
    const inside = cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
    if (inside && root.length > bestLen) { best = f; bestLen = root.length; }
  }
  return best;
}

/** What a site's row is called: its page title, else `localhost:<port>`. */
export function siteName(site: Pick<ServedSite, 'title' | 'port'>): string {
  return site.title?.trim() || `localhost:${site.port}`;
}

import type { ConnectorConfig, RemoteRepo, RepoExclusions } from '@nekko-agent/shared';

/**
 * Choosing a git connector's repositories (#2562): the repositories grouped
 * under their owner (a GitHub user or org, a GitLab top group), and the lists
 * of what the user removed. The daemon applies the same rule
 * (`nekko_connectors::repos::excluded`): names compare without case, and a
 * removed owner takes all of its repositories with it.
 */

/** The user or org a repository sits under: GitHub's owner, GitLab's top group. */
export const ownerOf = (fullName: string): string => fullName.split('/')[0] ?? fullName;

/** The saved choice on a connector entry, tolerating a missing or odd shape. */
export function exclusionsOf(cfg?: ConnectorConfig): RepoExclusions {
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : []);
  return { excludedRepos: names(cfg?.settings?.excludedRepos), excludedOwners: names(cfg?.settings?.excludedOwners) };
}

export interface RepoGroup {
  owner: string;
  repos: RemoteRepo[];
}

export interface RepoChoiceView {
  /** Owners with at least one kept repository, A to Z. */
  groups: RepoGroup[];
  /** Whole owners removed, with how many reachable repositories they hold. */
  removedOwners: { owner: string; count: number }[];
  /** Single repositories removed under an owner that is still kept. */
  removedRepos: RemoteRepo[];
  kept: number;
  total: number;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

export function groupRepos(repos: RemoteRepo[], ex: RepoExclusions): RepoChoiceView {
  const owners = new Set(ex.excludedOwners);
  const names = new Set(ex.excludedRepos);
  const groups = new Map<string, RepoGroup>();
  const removedOwners = new Map<string, { owner: string; count: number }>();
  const removedRepos: RemoteRepo[] = [];
  for (const repo of repos) {
    const owner = ownerOf(repo.fullName);
    if (owners.has(owner.toLowerCase())) {
      const g = removedOwners.get(owner.toLowerCase()) ?? { owner, count: 0 };
      g.count += 1;
      removedOwners.set(owner.toLowerCase(), g);
    } else if (names.has(repo.fullName.toLowerCase())) {
      removedRepos.push(repo);
    } else {
      const key = owner.toLowerCase();
      if (!groups.has(key)) groups.set(key, { owner, repos: [] });
      groups.get(key)!.repos.push(repo);
    }
  }
  // A removed owner with nothing reachable now still shows, so it can come back.
  for (const owner of owners) if (!removedOwners.has(owner)) removedOwners.set(owner, { owner, count: 0 });
  const list = [...groups.values()].sort((a, b) => byName(a.owner, b.owner));
  for (const g of list) g.repos.sort((a, b) => byName(a.fullName, b.fullName));
  return {
    groups: list,
    removedOwners: [...removedOwners.values()].sort((a, b) => byName(a.owner, b.owner)),
    removedRepos: removedRepos.sort((a, b) => byName(a.fullName, b.fullName)),
    kept: list.reduce((n, g) => n + g.repos.length, 0),
    total: repos.length,
  };
}

/** The choice with `name` removed (`remove`) or brought back, in one of the two lists. */
export function withChoice(ex: RepoExclusions, key: keyof RepoExclusions, name: string, remove: boolean): RepoExclusions {
  const lower = name.toLowerCase();
  const rest = ex[key].filter((n) => n !== lower);
  return { ...ex, [key]: remove ? [...rest, lower] : rest };
}

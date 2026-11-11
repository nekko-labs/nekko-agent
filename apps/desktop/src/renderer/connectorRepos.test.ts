import { describe, expect, it } from 'vitest';
import type { RemoteRepo } from '@nekko-agent/shared';
import { exclusionsOf, groupRepos, ownerOf, withChoice } from './connectorRepos.js';

const repo = (fullName: string): RemoteRepo => ({
  provider: 'github', id: fullName, fullName, cloneUrl: '', webUrl: '', defaultBranch: 'main', private: false, description: '', updatedAt: '',
});
const repos = ['nekko-labs/nekko-agent', 'ermish/notes', 'Nekko-Labs/floop', 'acme/site', 'acme/api', 'ermish/old'].map(repo);
const none = { excludedRepos: [], excludedOwners: [] };

describe('choosing a git connector\'s repositories (#2562)', () => {
  it('groups repositories under their owner, A to Z, ignoring case', () => {
    const view = groupRepos(repos, none);
    expect(view.groups.map((g) => g.owner)).toEqual(['acme', 'ermish', 'nekko-labs']);
    expect(view.groups[2].repos.map((r) => r.fullName)).toEqual(['Nekko-Labs/floop', 'nekko-labs/nekko-agent']);
    expect([view.kept, view.total]).toEqual([6, 6]);
    expect(ownerOf('grp/sub/tool')).toBe('grp');
  });

  it('moves a removed repository and a removed org out of the groups, keeping them to add back', () => {
    const ex = withChoice(withChoice(none, 'excludedRepos', 'ermish/Old', true), 'excludedOwners', 'ACME', true);
    expect(ex).toEqual({ excludedRepos: ['ermish/old'], excludedOwners: ['acme'] });
    const view = groupRepos(repos, ex);
    expect(view.groups.map((g) => g.owner)).toEqual(['ermish', 'nekko-labs']);
    expect(view.removedOwners).toEqual([{ owner: 'acme', count: 2 }]);
    expect(view.removedRepos.map((r) => r.fullName)).toEqual(['ermish/old']);
    expect([view.kept, view.total]).toEqual([3, 6]);
  });

  it('brings a name back, and never lists it twice', () => {
    const ex = withChoice(withChoice(none, 'excludedRepos', 'a/b', true), 'excludedRepos', 'A/B', true);
    expect(ex.excludedRepos).toEqual(['a/b']);
    expect(withChoice(ex, 'excludedRepos', 'A/b', false).excludedRepos).toEqual([]);
  });

  it('keeps a removed org with nothing reachable, so it can come back', () => {
    expect(groupRepos([], { excludedRepos: [], excludedOwners: ['gone'] }).removedOwners).toEqual([{ owner: 'gone', count: 0 }]);
  });

  it('reads the saved choice off the connector entry, tolerating odd shapes', () => {
    expect(exclusionsOf(undefined)).toEqual(none);
    expect(exclusionsOf({ kind: 'github', connected: true, settings: { excludedRepos: ['Me/App'], excludedOwners: 'x' } })).toEqual({ excludedRepos: ['me/app'], excludedOwners: [] });
  });
});

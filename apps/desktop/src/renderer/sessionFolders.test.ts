import { afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
import type { WorkspaceFolder } from '@nekko-agent/shared';
import { useStore } from './store.js';
import { addFolderToChat, addRepoToChat, RepoFolderNeeded, shouldAutoFile, withExcluded, withIncluded, withoutPrimary, withPrimary } from './sessionFolders.js';

const folder = (id: string, path = `/code/${id}`): WorkspaceFolder => ({ id, name: id, path, addedAt: 0 });

describe('folder selection rules', () => {
  it('demotes the old primary to supporting', () => {
    expect(withPrimary({ workspaceId: 'a', supportingWorkspaceIds: ['b', 'c'] }, 'c')).toEqual({ primary: 'c', supporting: ['a', 'b'] });
    expect(withPrimary(null, 'a')).toEqual({ primary: 'a', supporting: [] });
    expect(withPrimary({ workspaceId: 'a' }, 'a')).toEqual({ primary: 'a', supporting: [] });
  });

  it('clears the primary and keeps it as supporting', () => {
    expect(withoutPrimary({ workspaceId: 'a', supportingWorkspaceIds: ['b'] })).toEqual({ primary: undefined, supporting: ['a', 'b'] });
    expect(withoutPrimary({})).toEqual({ primary: undefined, supporting: [] });
  });

  it('includes as primary only when the chat has none', () => {
    expect(withIncluded({}, 'a')).toEqual({ primary: 'a', supporting: [] });
    expect(withIncluded({ workspaceId: 'a' }, 'b')).toEqual({ primary: 'a', supporting: ['b'] });
    expect(withIncluded({ workspaceId: 'a', supportingWorkspaceIds: ['b'] }, 'b')).toEqual({ primary: 'a', supporting: ['b'] });
  });

  it('promotes the first supporting folder when the primary is excluded', () => {
    expect(withExcluded({ workspaceId: 'a', supportingWorkspaceIds: ['b', 'c'] }, 'a')).toEqual({ primary: 'b', supporting: ['c'] });
    expect(withExcluded({ workspaceId: 'a', supportingWorkspaceIds: ['b', 'c'] }, 'c')).toEqual({ primary: 'a', supporting: ['b'] });
    expect(withExcluded({ workspaceId: 'a' }, 'a')).toEqual({ primary: undefined, supporting: [] });
  });
});

describe('auto-filing on send', () => {
  const prompt = { id: 'm', role: 'user' as const, content: 'hi', createdAt: 0 };

  it('files only an unfiled chat on its first prompt', () => {
    expect(shouldAutoFile({ messages: [] }, {})).toBe(true);
    expect(shouldAutoFile({ messages: [prompt] }, {})).toBe(false);
    expect(shouldAutoFile({ messages: [] }, { workspaceId: 'a' })).toBe(false);
    expect(shouldAutoFile(null, {})).toBe(false);
  });

  it('does not auto-file after an explicit No folder choice', () => {
    const storage = globalThis.localStorage;
    Object.assign(globalThis, { localStorage: { getItem: () => 'null' } });
    try { expect(shouldAutoFile({ messages: [] }, {})).toBe(false); }
    finally { Object.assign(globalThis, { localStorage: storage }); }
  });

  it('leaves a chat whose primary was cleared alone', () => {
    // withoutPrimary keeps the old primary as supporting.
    expect(shouldAutoFile({ messages: [] }, { supportingWorkspaceIds: ['a'] })).toBe(false);
  });
});

describe('adding a folder to a chat', () => {
  const prev = useStore.getState();
  afterEach(() => { useStore.setState({ settings: prev.settings, refreshSettings: prev.refreshSettings, refreshSessions: prev.refreshSessions }); });

  const setup = (picked: string | null, folders: WorkspaceFolder[]) => {
    const api = {
      pickFolder: vi.fn(async () => picked),
      addWorkspaceByPath: vi.fn(async () => folders),
      removeWorkspace: vi.fn(async () => folders),
      setSessionWorkspace: vi.fn(async () => null),
      setSessionSupportingWorkspaces: vi.fn(async () => ({ id: 's' })),
    };
    (globalThis as any).window.nekko = api;
    useStore.setState({ refreshSettings: vi.fn(async () => {}), refreshSessions: vi.fn(async () => {}) });
    return api;
  };

  it('does nothing when the picker is cancelled', async () => {
    const api = setup(null, [folder('a')]);
    expect(await addFolderToChat('s', { workspaceId: 'a' }, 'primary')).toBeNull();
    expect(api.addWorkspaceByPath).not.toHaveBeenCalled();
    expect(api.setSessionWorkspace).not.toHaveBeenCalled();
  });

  it('makes the new folder primary and keeps the old one', async () => {
    const api = setup('/code/b', [folder('a'), folder('b')]);
    await addFolderToChat('s', { workspaceId: 'a' }, 'primary');
    expect(api.addWorkspaceByPath).toHaveBeenCalledWith('/code/b');
    expect(api.setSessionWorkspace).toHaveBeenCalledWith('s', 'b');
    expect(api.setSessionSupportingWorkspaces).toHaveBeenCalledWith('s', ['a']);
    expect(useStore.getState().activeProjectId).toBe('b');
  });

  it('reuses an already registered folder', async () => {
    const api = setup('/code/b/', [folder('a'), folder('b')]);
    await addFolderToChat('s', { workspaceId: 'a' }, 'include');
    expect(api.removeWorkspace).not.toHaveBeenCalled();
    expect(api.setSessionWorkspace).toHaveBeenCalledWith('s', 'a');
    expect(api.setSessionSupportingWorkspaces).toHaveBeenCalledWith('s', ['b']);
  });

  it('asks for the repositories folder instead of adding anything when the daemon needs one (#2561)', async () => {
    const cloneRepo = vi.fn(async () => ({ needsFolder: true as const, suggested: '/home/me/nekko-repos' }));
    const setSessionFolders = vi.fn();
    (globalThis as any).window.nekko = { cloneRepo, setSessionFolders };
    const err = await addRepoToChat('s1', { workspaceId: null, supportingWorkspaceIds: [] } as any,
      { provider: 'github', fullName: 'me/app', cloneUrl: 'https://github.com/me/app.git', webUrl: '' }).catch((e) => e);
    expect(err).toBeInstanceOf(RepoFolderNeeded);
    expect(err.suggested).toBe('/home/me/nekko-repos');
    expect(setSessionFolders).not.toHaveBeenCalled();
  });

  it('adds a repository to a sandbox chat\'s sandbox, not this computer (#2561)', async () => {
    const session = { id: 's1', sandboxRepos: [{ provider: 'github', fullName: 'me/app', cloneUrl: '', webUrl: '' }] };
    const cloneRepo = vi.fn(async () => ({ sandbox: true as const, session }));
    (globalThis as any).window.nekko = { cloneRepo };
    const out = await addRepoToChat('s1', { workspaceId: null, supportingWorkspaceIds: [] } as any,
      { provider: 'github', fullName: 'me/app', cloneUrl: 'https://github.com/me/app.git', webUrl: '' });
    expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'me/app' }), { sessionId: 's1' });
    expect(out.session).toBe(session);
    expect(out.path).toContain('sandbox');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { environmentActions } from './environmentActions.js';

const { addFolderPathToChat } = vi.hoisted(() => ({ addFolderPathToChat: vi.fn() }));
vi.mock('./sessionFolders.js', () => ({ addFolderPathToChat }));
vi.mock('./store.js', () => ({
  useStore: { getState: () => ({ settings: { workspaces: [
    { id: 'primary', path: '/code' },
    { id: 'support', path: 'C:\\Code\\Support' },
    { id: 'unattached', path: '/repo' },
  ] } }) },
}));

const chat = () => ({ workspaceId: 'primary', supportingWorkspaceIds: ['support'] });

beforeEach(() => { addFolderPathToChat.mockReset(); });

describe('question folder actions', () => {
  it.each([
    '/code/app/.git/nekko-worktrees/model-settings',
    'C:\\Code\\App\\.git\\nekko-worktrees\\model-settings\\nested',
    '/code/',
    'c:/code/support/',
  ])('keeps %s out of workspace registration and the answer note', async (path) => {
    const onSession = vi.fn();
    const actions = environmentActions('s1', chat, onSession);
    await expect(actions.run({ kind: 'addFolder', path })).resolves.toBe('');
    expect(addFolderPathToChat).not.toHaveBeenCalled();
    expect(onSession).not.toHaveBeenCalled();
  });

  it.each(['/repo', '/code/new-project'])('attaches the explicitly selected project at %s', async (path) => {
    const session = { id: 's1' };
    addFolderPathToChat.mockResolvedValue({ session, folder: { name: 'Project', path } });
    const onSession = vi.fn();
    const actions = environmentActions('s1', chat, onSession);
    await expect(actions.run({ kind: 'addFolder', path })).resolves.toContain(`Added the folder Project to this chat's environment at ${path}.`);
    expect(addFolderPathToChat).toHaveBeenCalledWith('s1', chat(), path);
    expect(onSession).toHaveBeenCalledWith(session);
  });
});

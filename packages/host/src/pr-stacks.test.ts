import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ git: vi.fn(), fetch: vi.fn(), request: vi.fn(), get: vi.fn(), create: vi.fn(), save: vi.fn(), settings: vi.fn(), fetchPr: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mock.git, execFile: mock.fetch }));
vi.mock('./pr.js', () => ({ githubStackRequest: mock.request, refreshPrInfo: mock.fetchPr }));
vi.mock('./sessions.js', () => ({ getSession: mock.get, createSession: mock.create, saveSession: mock.save }));
vi.mock('./store.js', () => ({ getSettings: mock.settings }));
import { continuePrStack, githubRemoteRepo, linkPrStack, requireStackablePr } from './pr-stacks.js';

const slug = 'owner/repo', url = 'https://github.com/owner/repo/pull/12', child = 'https://github.com/owner/repo/pull/13';
const sha = 'a'.repeat(40);
const parentPr = () => ({ state: 'open', head: { ref: 'parent', sha, repo: { full_name: slug } }, base: { ref: 'main', repo: { full_name: slug } } });
const source = () => ({ id: 'source', messages: [], executionMode: 'worktree', workspaceId: 'repo', providerId: 'p', modelId: 'm', mode: 'ask', disabledTools: ['browser'] });
const dependent = () => ({ ...source(), gitStackParent: { workspaceId: 'repo', url, branch: 'parent', sha }, gitWorktrees: { repo: { path: '/dependent', branch: 'nekko/child' } } });
beforeEach(() => {
  vi.resetAllMocks();
  mock.fetch.mockImplementation((_bin, _args, _opts, done) => done(null));
  mock.get.mockReturnValue(source()); mock.create.mockReturnValue({ id: 'new', messages: [] });
  mock.settings.mockReturnValue({ workspaces: [{ id: 'repo', path: '/repo' }] });
  mock.request.mockImplementation(async (path) => path.includes('/stacks') ? [] : path.endsWith('/13') ? { ...parentPr(), head: { ...parentPr().head, ref: 'nekko/child' }, base: { ...parentPr().base, ref: 'parent' } } : parentPr());
  mock.git.mockImplementation((_cwd, args) => args[0] === 'remote' ? args.length === 1 ? 'origin\n' : 'git@github.com:owner/repo.git\n' : args[0] === 'rev-parse' ? sha + '\n' : args[0] === 'branch' ? 'nekko/child\n' : '');
});
it('matches GitHub remotes exactly', () => {
  expect(githubRemoteRepo('git@github.com:Owner/Repo.git')).toBe(slug);
  expect(githubRemoteRepo('https://github.com/owner/repo.git')).toBe(slug);
  expect(githubRemoteRepo('ssh://git@github.com/owner/repo.git')).toBe(slug);
  expect(githubRemoteRepo('https://github.com.attacker.test/owner/repo.git')).toBeNull();
  expect(githubRemoteRepo('https://github.com/owner/repo.git/extra')).toBeNull();
});
it('fetches only a matching registered project and creates a pinned independent session', async () => {
  const s = await continuePrStack('source', url);
  expect(s.gitStackParent).toEqual({ workspaceId: 'repo', url, branch: 'parent', sha });
  expect(s.providerId).toBe('p'); expect(s.mode).toBe('ask'); expect(s.disabledTools).toEqual(['browser']);
  expect(mock.fetch).toHaveBeenCalledWith('git', ['fetch', '--no-tags', 'origin', `refs/heads/parent:refs/nekko/pr-bases/${sha}`], expect.objectContaining({ cwd: '/repo' }), expect.any(Function));
  expect(mock.save).toHaveBeenCalledWith(s);
});
it.each([{ offline: true }, { incognito: true }, { executionMode: 'sandbox' }, { archivedAt: 1 }])('rejects private or inactive source sessions before network access: %s', async (patch) => {
  mock.get.mockReturnValue({ ...source(), ...patch });
  await expect(continuePrStack('source', url)).rejects.toThrow();
  expect(mock.request).not.toHaveBeenCalled();
});
it('rejects forks, closed parents, unmatched projects and parent fetch races', async () => {
  expect(() => requireStackablePr({ ...parentPr(), state: 'closed' }, slug)).toThrow('still be open');
  expect(() => requireStackablePr({ ...parentPr(), head: { ...parentPr().head, repo: { full_name: 'other/repo' } } }, slug)).toThrow('Fork PRs');
  mock.settings.mockReturnValue({ workspaces: [] });
  await expect(continuePrStack('source', url)).rejects.toThrow('Select a local project');
  mock.settings.mockReturnValue({ workspaces: [{ id: 'repo', path: '/repo' }] });
  mock.git.mockImplementation((_cwd, args) => args[0] === 'remote' ? args.length === 1 ? 'origin' : 'https://github.com/owner/repo.git' : args[0] === 'rev-parse' ? 'b'.repeat(40) : '');
  await expect(continuePrStack('source', url)).rejects.toThrow('changed while fetching');
  expect(mock.create).not.toHaveBeenCalled();
});
it('creates the native stack in dependency order', async () => {
  mock.get.mockReturnValue(dependent());
  expect((await linkPrStack('source', child)).ok).toBe(true);
  expect(mock.request).toHaveBeenCalledWith(`repos/${slug}/stacks`, [12, 13]);
});
it('rejects continuation from the middle of an existing stack before fetching', async () => {
  mock.request.mockImplementation(async path => path.includes('/stacks/') ? { pull_requests: [{ number: 12 }, { number: 14 }] } : { ...parentPr(), stack: { number: 3 } });
  await expect(continuePrStack('source', url)).rejects.toThrow('top PR');
  expect(mock.fetch).not.toHaveBeenCalled();
  expect(mock.create).not.toHaveBeenCalled();
});
it('extends the current top and treats successful retries as read-only', async () => {
  mock.get.mockReturnValue(dependent());
  const prior = mock.request.getMockImplementation()!;
  mock.request.mockImplementation(async (path, body) => path.includes('?pull_request=') ? [{ number: 3, pull_requests: [{ number: 10 }, { number: 12 }] }] : prior(path, body));
  expect((await linkPrStack('source', child)).ok).toBe(true);
  expect(mock.request).toHaveBeenCalledWith(`repos/${slug}/stacks/3/add`, [13]);
  mock.request.mockClear();
  mock.request.mockImplementation(async (path, body) => path.includes('?pull_request=') ? [{ number: 3, pull_requests: [{ number: 12 }, { number: 13 }] }] : prior(path, body));
  expect((await linkPrStack('source', child)).ok).toBe(true);
  expect(mock.request.mock.calls.some(args => args[1])).toBe(false);
});
it('rejects unrelated branches and non-top parents without writing GitHub', async () => {
  mock.get.mockReturnValue({ ...dependent(), gitWorktrees: { repo: { path: '/dependent', branch: 'unrelated' } } });
  expect((await linkPrStack('source', child)).ok).toBe(false);
  expect(mock.request.mock.calls.some(args => args[1])).toBe(false);
  mock.get.mockReturnValue(dependent());
  const prior = mock.request.getMockImplementation()!;
  mock.request.mockImplementation(async (path, body) => path.includes('?pull_request=') ? [{ number: 3, pull_requests: [{ number: 12 }, { number: 14 }] }] : prior(path, body));
  expect((await linkPrStack('source', child)).message).toContain('top PR');
  expect(mock.request.mock.calls.some(args => args[1])).toBe(false);
});

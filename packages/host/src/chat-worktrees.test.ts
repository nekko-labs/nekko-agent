import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AppSettings, Session } from '@nekko-agent/shared';
import { chatWorkspaces, listChatWorktrees, prepareChatWorktrees, removeChatWorktree, runWorktreeSetup, slugifyTitle, worktreeName } from './chat-worktrees.js';

let root: string;
let settings: AppSettings;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
const session = (id: string): Session => ({ id, title: 'New chat', workspaceId: 'repo', gitIsolation: true, messages: [], createdAt: 1, updatedAt: 1 });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nekko-worktree-'));
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'file.txt'), 'committed\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  settings = { workspaces: [{ id: 'repo', name: 'Repo', path: root }] } as AppSettings;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('isolates concurrent chats from HEAD and preserves local edits', () => {
  writeFileSync(join(root, 'file.txt'), 'local edits\n');
  const a = session('s_a'), b = session('s_b');
  prepareChatWorktrees(a, settings);
  prepareChatWorktrees(b, settings);
  expect(a.gitWorktrees!.repo.path).not.toBe(b.gitWorktrees!.repo.path);
  expect(readFileSync(join(a.gitWorktrees!.repo.path, 'file.txt'), 'utf8')).toBe('committed\n');
  expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('local edits\n');
  expect(a.gitWorktrees!.repo.notice).not.toContain('Interrupt');
  expect(a.gitWorktrees!.repo.notice).toContain('Existing local changes are not included.');
  expect(chatWorkspaces(a, settings)[0].path).toBe(a.gitWorktrees!.repo.path);
  prepareChatWorktrees(a, settings); // idempotent
});
it('copies tracked edits only when configured', () => {
  writeFileSync(join(root, 'file.txt'), 'local edits\n');
  writeFileSync(join(root, 'secret.txt'), 'not copied');
  settings.gitManagement = { baseline: 'local-changes' };
  const a = session('s_copy');
  prepareChatWorktrees(a, settings);
  expect(readFileSync(join(a.gitWorktrees!.repo.path, 'file.txt'), 'utf8')).toBe('local edits\n');
  expect(existsSync(join(a.gitWorktrees!.repo.path, 'secret.txt'))).toBe(false);
});
it('starts a dependent chat from the parent PR commit and sets its default PR base', () => {
  git('checkout', '-b', 'parent-feature');
  writeFileSync(join(root, 'file.txt'), 'parent PR code\n');
  git('add', '.'); git('commit', '-m', 'Parent feature');
  const sha = git('rev-parse', 'HEAD').trim();
  git('checkout', '-');
  writeFileSync(join(root, 'file.txt'), 'user edits\n');
  settings.gitManagement = { baseline: 'local-changes' };
  const s = session('stack');
  s.gitStackParent = { workspaceId: 'repo', url: 'https://github.com/owner/repo/pull/12', branch: 'parent-feature', sha };
  prepareChatWorktrees(s, settings);
  const wt = s.gitWorktrees!.repo;
  expect(readFileSync(join(wt.path, 'file.txt'), 'utf8')).toBe('parent PR code\n');
  expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('user edits\n');
  expect(execFileSync('git', ['config', `branch.${wt.branch}.gh-merge-base`], { cwd: wt.path, encoding: 'utf8', windowsHide: true }).trim()).toBe('parent-feature');
  expect(wt.notice).toContain(s.gitStackParent.url);
  expect(wt.notice).toContain('Link stack');
  expect(prepareChatWorktrees(s, settings)).toEqual([]);
});
it('does not move existing chats without per-session isolation, but ignores global shared mode', () => {
  const old = session('s_old'); delete old.gitIsolation;
  prepareChatWorktrees(old, settings);
  expect(old.gitWorktrees).toBeUndefined();
  settings.gitManagement = { mode: 'shared' };
  const isolated = session('s_isolated'); prepareChatWorktrees(isolated, settings);
  expect(isolated.gitWorktrees!.repo.path).not.toBe(root);
});

it('preserves saved worktrees but resolves shared-mode sessions to configured folders', () => {
  const a = session('s_switch');
  prepareChatWorktrees(a, settings);
  const saved = a.gitWorktrees!.repo.path;
  expect(chatWorkspaces(a, settings)[0].path).toBe(saved);
  a.gitIsolation = false;
  expect(a.gitWorktrees!.repo.path).toBe(saved);
  expect(chatWorkspaces(a, settings)[0].path).toBe(root);
  expect(prepareChatWorktrees(a, settings)).toEqual([]);
  expect(a.gitWorktrees!.repo.path).toBe(saved);
});
it('copies only gitignored files listed in .worktreeinclude', () => {
  writeFileSync(join(root, '.gitignore'), '.env\nbuild/\n');
  writeFileSync(join(root, '.worktreeinclude'), '.env\nnotes.txt\n');
  git('add', '.gitignore', '.worktreeinclude');
  git('commit', '-m', 'Ignore');
  writeFileSync(join(root, '.env'), 'TOKEN=local\n');
  writeFileSync(join(root, 'notes.txt'), 'untracked but not ignored');
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'build', 'out.js'), 'not listed');
  const a = session('s_incl');
  prepareChatWorktrees(a, settings);
  const wt = a.gitWorktrees!.repo.path;
  expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('TOKEN=local\n');
  expect(existsSync(join(wt, 'notes.txt'))).toBe(false);
  expect(existsSync(join(wt, 'build'))).toBe(false);
  expect(a.gitWorktrees!.repo.notice).toContain('.worktreeinclude: .env');
});
it('lists, removes, and restores chat worktrees without losing work', () => {
  const a = session('s_life');
  expect(prepareChatWorktrees(a, settings)).toHaveLength(1);
  const wt = a.gitWorktrees!.repo.root;
  const branch = a.gitWorktrees!.repo.branch;
  expect(branch).toMatch(/^nekko\/[a-z]+-[a-z]+-[a-z]+$/);
  const owner = (root: string) => (root === wt ? { id: 's_life', title: 'Life', running: false } : null);
  let [info] = listChatWorktrees(settings, owner);
  expect(info).toMatchObject({ sessionId: 's_life', sessionTitle: 'Life', branch, dirtyCount: 0, unmergedCount: 0 });

  // Uncommitted work and a running chat both block removal.
  writeFileSync(join(wt, 'file.txt'), 'work in progress\n');
  expect(() => removeChatWorktree(settings, wt, owner)).toThrow(/uncommitted/);
  execFileSync('git', ['commit', '-am', 'Chat work'], { cwd: wt });
  expect(() => removeChatWorktree(settings, wt, () => ({ id: 's_life', title: 'Life', running: true }))).toThrow(/running/);
  [info] = listChatWorktrees(settings, owner);
  expect(info.unmergedCount).toBe(1);

  // An unmerged branch survives removal, and the chat comes back on it.
  expect(removeChatWorktree(settings, wt, owner)).toEqual({ branchDeleted: false });
  expect(existsSync(wt)).toBe(false);
  expect(listChatWorktrees(settings, owner)).toHaveLength(0);
  mkdirSync(wt); // Windows can leave the emptied folder behind while a terminal has it open
  expect(prepareChatWorktrees(a, settings)).toHaveLength(1);
  expect(readFileSync(join(wt, 'file.txt'), 'utf8')).toBe('work in progress\n');
  expect(a.gitWorktrees!.repo.notice).toContain('restored from its branch');

  // Once merged, the branch goes with the folder.
  git('merge', '--ff-only', branch!);
  expect(removeChatWorktree(settings, wt, owner)).toEqual({ branchDeleted: true });
  expect(() => removeChatWorktree(settings, root, owner)).toThrow(/not a chat worktree/);
});
it('runs setup commands and reports failures without throwing', async () => {
  let out = '';
  const ok = await runWorktreeSetup('echo setup-ran', root, (t) => { out += t; });
  expect(ok.ok).toBe(true);
  expect(out).toContain('setup-ran');
  const bad = await runWorktreeSetup('exit 3', root, () => {});
  expect(bad).toEqual({ ok: false, detail: 'exit code 3' });
});
it('names checkouts after a chosen title, else with three words, never colliding', () => {
  expect(slugifyTitle('Fix the  Login/Bug! (round 2)')).toBe('fix-the-login-bug-round-2');
  expect(slugifyTitle('x'.repeat(60)).length).toBeLessThanOrEqual(40);
  const titled = { title: 'Fix login bug', titleAuto: false };
  expect(worktreeName(titled, () => false)).toBe('fix-login-bug');
  expect(worktreeName(titled, (n) => n === 'fix-login-bug')).toBe('fix-login-bug-2');
  // An app-written placeholder title is not a name worth keeping.
  const auto = { title: 'write me a test for the login flow', titleAuto: true };
  expect(worktreeName(auto, () => false, () => 0)).toBe('brisk-amber-otter');
  expect(worktreeName({ title: 'New chat' }, () => false, () => 0.999)).toBe('tidy-cobalt-cat');
  // A taken draw is redrawn.
  let draws = 0;
  const rolling = () => (draws++ < 3 ? 0 : 0.5);
  expect(worktreeName({ title: 'New chat' }, (n) => n === 'brisk-amber-otter', rolling)).not.toBe('brisk-amber-otter');
  // Two chats on one repository never share a folder.
  const a = session('s_one'), b = session('s_two');
  prepareChatWorktrees(a, settings);
  prepareChatWorktrees(b, settings);
  expect(a.gitWorktrees!.repo.root).not.toBe(b.gitWorktrees!.repo.root);
  expect(a.gitWorktrees!.repo.branch).not.toBe(b.gitWorktrees!.repo.branch);
});

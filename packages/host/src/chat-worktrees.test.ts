import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AppSettings, Session } from '@nekko-agent/shared';
import { chatWorkspaces, listChatWorktrees, prepareChatWorktrees, removeChatWorktree, removeMergedChatWorktrees, runWorktreeSetup, slugifyTitle, worktreeName } from './chat-worktrees.js';

const execFileAsync = promisify(execFile);
let root: string;
let template: string;
let settings: AppSettings;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
const session = (id: string): Session => ({ id, title: 'New chat', workspaceId: 'repo', gitIsolation: true, messages: [], createdAt: 1, updatedAt: 1 });
// One committed repository is built per file and copied for each test: every
// test still gets its own independent repository, without re-running five git
// processes to make it. Auto maintenance is off so the test's own commits do
// not each spawn a `git maintenance run --auto`.
beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), 'nekko-worktree-template-'));
  const init = (...args: string[]) => execFileSync('git', args, { cwd: template, windowsHide: true });
  init('init');
  init('config', 'user.email', 'test@example.com');
  init('config', 'user.name', 'Test');
  init('config', 'maintenance.auto', 'false');
  init('config', 'gc.auto', '0');
  writeFileSync(join(template, 'file.txt'), 'committed\n');
  init('add', '.');
  init('commit', '-m', 'Initial');
});
afterAll(() => rmSync(template, { recursive: true, force: true }));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nekko-worktree-'));
  cpSync(template, root, { recursive: true });
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
it('removes the worktree and branch of a merged PR, and leaves everything else', async () => {
  const merged = session('s_merged'), open = session('s_open'), dirty = session('s_dirty'), busy = session('s_busy');
  const reused = session('s_reused'), after = session('s_after');
  const all4 = [merged, open, dirty, busy, reused, after];
  for (const s of all4) prepareChatWorktrees(s, settings);
  const at = (s: Session) => s.gitWorktrees!.repo;
  // Each worktree is its own checkout, so their commits run side by side.
  const commit = async (s: Session, name: string) => {
    const run = async (...args: string[]) => (await execFileAsync('git', args, { cwd: at(s).root, encoding: 'utf8', windowsHide: true })).stdout;
    writeFileSync(join(at(s).root, name), 'work\n');
    await run('add', '.');
    await run('commit', '-m', name);
    return (await run('rev-parse', 'HEAD')).trim();
  };
  // Squash-merged work: Git still sees the branch as unmerged. GitHub reports
  // the head commit each PR merged with.
  const heads = new Map<Session, string>();
  await Promise.all(all4.map(async (s) => {
    heads.set(s, await commit(s, `${s.id}.txt`));
    // Work committed after the PR merged.
    if (s === after) await commit(after, 'after-merge.txt');
  }));
  // The merged PR was an older one of the same name: its head is not this tip.
  heads.set(reused, 'a'.repeat(40));
  writeFileSync(join(at(dirty).root, 'file.txt'), 'not committed\n');
  const owner = (wt: string) => {
    const s = all4.find((x) => at(x).root === wt);
    return s ? { id: s.id, title: s.id, running: s === busy } : null;
  };
  const asked: string[] = [];
  const pr = async (_cwd: string, branch: string) => {
    asked.push(branch);
    const s = all4.find((x) => at(x).branch === branch)!;
    return { state: s === open ? 'open' as const : 'merged' as const, headOid: heads.get(s)! };
  };

  const removed = await removeMergedChatWorktrees(settings, owner, pr);
  expect(removed.map((r) => r.sessionId)).toEqual(['s_merged']);
  expect(existsSync(at(merged).root)).toBe(false);
  expect(git('branch', '--list', at(merged).branch!).trim()).toBe('');
  // Kept: an open PR, uncommitted edits, a running chat (the last two are not
  // even asked about), a reused branch name and work committed after the merge.
  for (const s of [open, dirty, busy, reused, after]) expect(existsSync(at(s).root)).toBe(true);
  for (const s of [reused, after]) expect(git('branch', '--list', at(s).branch!).trim()).not.toBe('');
  expect(asked).not.toContain(at(dirty).branch);
  expect(asked).not.toContain(at(busy).branch);

  // Off in Settings, or a lookup that fails: nothing is removed.
  const all = async (cwd: string) => ({ state: 'merged' as const, headOid: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() });
  expect(await removeMergedChatWorktrees({ ...settings, gitManagement: { removeMerged: false } }, owner, all)).toEqual([]);
  expect(await removeMergedChatWorktrees(settings, owner, async () => { throw new Error('offline'); })).toEqual([]);
  expect(existsSync(at(open).root)).toBe(true);
}, 15_000); // ~70 real git processes; Windows process start alone nears the 5 s default under a full parallel run.
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

it('keeps aliased folders inside their isolated checkout', () => {
  const holder = mkdtempSync(join(tmpdir(), 'nekko-worktree-alias-'));
  const alias = join(holder, 'project');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    writeFileSync(join(root, 'file.txt'), 'source only\n');
    settings.workspaces[0].path = alias;
    const a = session('s_alias');
    prepareChatWorktrees(a, settings);
    expect(a.gitWorktrees!.repo.path).toBe(a.gitWorktrees!.repo.root);
    expect(readFileSync(join(a.gitWorktrees!.repo.path, 'file.txt'), 'utf8')).toBe('committed\n');
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('source only\n');
    expect(chatWorkspaces(a, settings)[0].path).toBe(a.gitWorktrees!.repo.path);
    a.gitWorktrees!.repo.path = alias; // Repair a mapping saved with the old alias bug.
    prepareChatWorktrees(a, settings);
    expect(a.gitWorktrees!.repo.path).toBe(a.gitWorktrees!.repo.root);
    settings.workspaces[0].path = holder;
    expect(() => prepareChatWorktrees(a, settings)).toThrow('no longer belongs');
  } finally { if (process.platform === 'win32') rmdirSync(alias); else unlinkSync(alias); rmdirSync(holder); }
});

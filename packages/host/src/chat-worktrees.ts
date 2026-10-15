import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, join, resolve, relative, sep, isAbsolute } from 'node:path';
import type { AppSettings, ChatWorktreeInfo, Session, WorkspaceFolder } from '@nekko-agent/shared';
import { getSessionWorkspaceIds } from '@nekko-agent/shared';

type Checkout = NonNullable<Session['gitWorktrees']>[string];

function stackNotice(parent: NonNullable<Session['gitStackParent']>): string {
  return `This chat builds on ${parent.url}, branch ${parent.branch}, committed snapshot ${parent.sha}. Create the dependent PR against ${parent.branch}; gh pr create uses this configured base. After publishing, use Link stack in the PR panel to register it with GitHub. Recheck the parent before publishing; if it changes or merges, explicitly rebase this branch when safe. Never automatically reset other worktrees or force push.`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  try { git(cwd, args); return true; } catch { return false; }
}

// Windows paths compare case-insensitively; Git reports them with forward slashes.
function diskPath(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}
const norm = (p: string) => process.platform === 'win32' ? diskPath(p).toLowerCase() : diskPath(p);

/**
 * The words a checkout's folder and branch are made of when the chat has no
 * name of its own yet (a new chat is provisioned on its first send, before its
 * title has been written). Two adjectives and an animal, the way container
 * tools name things: `nekko/brisk-amber-otter` reads in `git branch` and in a
 * terminal prompt where `nekko/s_musa1d91_vYHqPXOk` did not.
 */
const WORD_A = ['brisk', 'calm', 'bold', 'quiet', 'swift', 'keen', 'bright', 'gentle', 'nimble', 'steady', 'lucky', 'merry', 'plucky', 'clever', 'sunny', 'cosy', 'eager', 'witty', 'mellow', 'tidy'];
const WORD_B = ['amber', 'coral', 'indigo', 'jade', 'olive', 'rose', 'sage', 'teal', 'violet', 'copper', 'silver', 'golden', 'ivory', 'maple', 'ochre', 'pearl', 'plum', 'ruby', 'slate', 'cobalt'];
const WORD_C = ['otter', 'heron', 'lynx', 'badger', 'falcon', 'marten', 'ibis', 'puffin', 'stoat', 'wren', 'tapir', 'quokka', 'gecko', 'koala', 'finch', 'moth', 'robin', 'seal', 'fox', 'cat'];

/** A random `adjective-colour-animal`, from the lists above. */
export function randomWorktreeName(random: () => number = Math.random): string {
  const pick = (list: string[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  return `${pick(WORD_A)}-${pick(WORD_B)}-${pick(WORD_C)}`;
}

/** A title as a folder and branch name: lowercase ASCII words joined by dashes, at most 40 characters. */
export function slugifyTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/**
 * What to call a chat's checkout. A title the user (or the agent, through
 * `set_chat_title`) chose names it; otherwise it gets three random words.
 * `taken` says whether a folder or branch of that name already exists, in
 * which case a numbered suffix (or a fresh draw) keeps it unique.
 */
export function worktreeName(session: Pick<Session, 'title' | 'titleAuto'>, taken: (name: string) => boolean, random: () => number = Math.random): string {
  const chosen = session.titleAuto === false && session.title && session.title !== 'New chat' ? slugifyTitle(session.title) : '';
  if (chosen) {
    if (!taken(chosen)) return chosen;
    for (let n = 2; n < 100; n++) if (!taken(`${chosen}-${n}`)) return `${chosen}-${n}`;
  }
  for (let i = 0; i < 50; i++) {
    const name = randomWorktreeName(random);
    if (!taken(name)) return name;
  }
  return `${randomWorktreeName(random)}-${Date.now().toString(36)}`;
}

/**
 * Provision lazily: a new chat may select its project after creation. Old chats never opt in implicitly.
 * Returns the checkouts created on this call (new, or restored after removal), one per repository,
 * so the caller can run each project's setup command in them.
 */
export function prepareChatWorktrees(session: Session, settings: AppSettings): Array<{ id: string; checkout: Checkout }> {
  if (!session.gitIsolation) return [];
  session.gitWorktrees ??= {};
  const created = restoreRemovedWorktrees(session);
  for (const id of getSessionWorkspaceIds(session)) {
    const folder = settings.workspaces.find((w) => w.id === id);
    if (!folder) continue;
    const saved = session.gitWorktrees[id];
    if (saved) {
      const sub = relative(diskPath(saved.sourceRoot), diskPath(folder.path));
      if (sub === '..' || sub.startsWith('..' + sep) || isAbsolute(sub)) throw new Error('The configured folder no longer belongs to this chat worktree.');
      saved.path = join(saved.root, sub);
      continue;
    }
    // Distinguish ordinary folders from Git failures; a broken Git checkout must not silently run shared.
    let root: string;
    try { root = git(folder.path, ['rev-parse', '--show-toplevel']); }
    catch (error) {
      const message = String((error as { stderr?: unknown }).stderr ?? error);
      if (/not a git repository/i.test(message)) continue;
      throw new Error(`Could not inspect Git project ${folder.name}: ${message}`);
    }
    const existing = Object.values(session.gitWorktrees).find((w) => norm(w.sourceRoot) === norm(root));
    if (existing) {
      session.gitWorktrees[id] = { ...existing, path: join(existing.root, relative(diskPath(root), diskPath(folder.path))) };
      continue;
    }
    const dirty = !!git(root, ['status', '--porcelain']);
    const parent = session.gitStackParent?.workspaceId === id ? session.gitStackParent : undefined;
    if (parent && !/^[a-f0-9]{40,64}$/i.test(parent.sha)) throw new Error('Invalid parent PR commit. Start the stacked chat again.');
    const common = resolve(root, git(root, ['rev-parse', '--git-common-dir']));
    const home = join(common, 'nekko-worktrees');
    const name = worktreeName(session, (n) => existsSync(join(home, n)) || gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/heads/nekko/${n}`]));
    const target = join(home, name);
    const branch = `nekko/${name}`;
    mkdirSync(home, { recursive: true });
    let copied: string[] = [];
    try {
      git(root, ['worktree', 'add', '-b', branch, target, parent?.sha ?? 'HEAD']);
      if (parent) git(target, ['config', `branch.${branch}.gh-merge-base`, parent.branch]);
      if (!parent && dirty && settings.gitManagement?.baseline === 'local-changes') {
        const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        if (patch.length) {
          const patchPath = join(common, 'nekko-worktrees', `${session.id}.patch`);
          try { writeFileSync(patchPath, patch); git(target, ['apply', patchPath]); }
          finally { unlinkSync(patchPath); }
        }
        // Untracked files are not copied: they may include secrets or large build artifacts.
      }
      copied = copyWorktreeIncludes(root, target);
    } catch (error) {
      throw new Error(`Could not prepare isolated checkout for ${folder.name}. No shared-checkout fallback was used: ${String(error)}`);
    }
    const base = parent
      ? stackNotice(parent)
      : dirty
      ? settings.gitManagement?.baseline === 'local-changes'
        ? 'This chat uses an isolated worktree with tracked local edits copied in. Untracked files were not copied.'
        : 'This chat starts in an isolated worktree from committed HEAD. Existing local changes are not included.'
      : 'This chat uses an isolated Git worktree from committed HEAD.';
    const checkout: Checkout = {
      sourceRoot: root, root: target, path: join(target, relative(diskPath(root), diskPath(folder.path))), branch,
      notice: copied.length ? `${base} Copied from .worktreeinclude: ${copied.join(', ')}.` : base,
    };
    session.gitWorktrees[id] = checkout;
    created.push({ id, checkout });
  }
  return created;
}

/**
 * Bring back a chat's worktree after it was removed (from Settings, or by hand
 * with Git), so continuing an old chat never runs in the shared checkout. Its
 * branch keeps any committed work; a branch that was deleted because it had
 * merged starts again from HEAD under the same name.
 */
function restoreRemovedWorktrees(session: Session): Array<{ id: string; checkout: Checkout }> {
  const restored: Array<{ id: string; checkout: Checkout }> = [];
  const entries = Object.entries(session.gitWorktrees ?? {});
  const roots = [...new Set(entries.map(([, w]) => w.root))];
  for (const root of roots) {
    // A linked worktree has a `.git` file; a bare folder left behind (Windows
    // keeps one a terminal still has open) is not a checkout.
    if (existsSync(join(root, '.git'))) continue;
    const first = entries.find(([, w]) => w.root === root)!;
    const { sourceRoot, branch } = first[1];
    let notice: string;
    try {
      gitOk(sourceRoot, ['worktree', 'prune']);
      if (gitOk(sourceRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
        git(sourceRoot, ['worktree', 'add', root, branch]);
        notice = `This chat's worktree had been removed; it was restored from its branch ${branch}.`;
      } else {
        if (session.gitStackParent) throw new Error('The stacked chat branch was removed. Start a new continuation from the parent PR to avoid losing its dependency.');
        git(sourceRoot, ['worktree', 'add', '-b', branch, root, 'HEAD']);
        notice = `This chat's worktree and branch had been removed; it continues on ${branch}, freshly created from committed HEAD.`;
      }
    } catch (error) {
      throw new Error(`Could not restore this chat's worktree at ${root}. No shared-checkout fallback was used: ${String(error)}`);
    }
    const copied = copyWorktreeIncludes(sourceRoot, root);
    if (session.gitStackParent) notice += ` ${stackNotice(session.gitStackParent)}`;
    if (copied.length) notice += ` Copied from .worktreeinclude: ${copied.join(', ')}.`;
    for (const [, w] of entries) if (w.root === root) w.notice = notice;
    restored.push({ id: first[0], checkout: first[1] });
  }
  return restored;
}

/**
 * Copy the gitignored files a project lists in `.worktreeinclude` (gitignore
 * syntax; the same file Claude Code reads), such as `.env.local`, into a new
 * worktree. A fresh checkout has only tracked files, so without this an agent
 * cannot run anything that needs local config. Only paths that match the list
 * AND are ignored by Git are copied; existing files are never overwritten.
 */
export function copyWorktreeIncludes(root: string, target: string): string[] {
  const list = join(root, '.worktreeinclude');
  if (!existsSync(list)) return [];
  const candidates = git(root, ['ls-files', '-z', '--others', '--ignored', '--directory', '--no-empty-directory', '--exclude-from', list]);
  if (!candidates) return [];
  let ignored: string[];
  try {
    // check-ignore applies the repository's own ignore rules; it exits 1 when nothing matches.
    ignored = execFileSync('git', ['check-ignore', '-z', '--stdin'], { cwd: root, input: candidates, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30_000 })
      .split('\0').filter(Boolean);
  } catch {
    return [];
  }
  const copied: string[] = [];
  for (const rel of ignored) {
    const to = join(target, rel);
    if (existsSync(to)) continue;
    cpSync(join(root, rel), to, { recursive: true, force: false });
    copied.push(rel.replace(/\/$/, ''));
  }
  return copied;
}

/**
 * Run a project's worktree setup command (e.g. `npm install`) in a chat's new
 * checkout. Never rejects: the chat can still read and edit code without it,
 * so a failure is reported to the chat instead of stopping the turn.
 */
export function runWorktreeSetup(command: string, cwd: string, onOutput: (text: string) => void, timeoutMs = 15 * 60_000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // A shell's children outlive it on Windows unless the whole tree is killed.
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d) => onOutput(String(d)));
    child.stderr?.on('data', (d) => onOutput(String(d)));
    child.on('error', (error) => { clearTimeout(timer); done({ ok: false, detail: error.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) done({ ok: false, detail: `stopped after ${Math.round(timeoutMs / 60_000)} minutes` });
      else done(code === 0 ? { ok: true, detail: '' } : { ok: false, detail: `exit code ${code}` });
    });
  });
}

/** The workspace folders a chat works in, with each Git project pointed at the chat's own checkout. */
export function chatWorkspaces(session: Session | null, settings: AppSettings): WorkspaceFolder[] {
  if (!session) return settings.workspaces;
  return getSessionWorkspaceIds(session).flatMap((id) => {
    const folder = settings.workspaces.find((w) => w.id === id);
    return folder ? [{ ...folder, path: session.gitIsolation === false ? folder.path : session.gitWorktrees?.[id]?.path ?? folder.path }] : [];
  });
}

/** Every chat worktree in the configured projects' repositories, found through Git rather than chat records, so deleted chats' checkouts show up too. */
export function listChatWorktrees(settings: AppSettings, lookup: (worktreeRoot: string) => { id: string; title: string; running: boolean } | null): ChatWorktreeInfo[] {
  const repos = new Map<string, string>();
  for (const folder of settings.workspaces) {
    try {
      const common = resolve(folder.path, git(folder.path, ['rev-parse', '--git-common-dir']));
      repos.set(norm(common), common);
    } catch { /* not a repository */ }
  }
  const out: ChatWorktreeInfo[] = [];
  for (const common of repos.values()) {
    const home = join(common, 'nekko-worktrees');
    let list: string;
    try { list = git(common, ['worktree', 'list', '--porcelain']); } catch { continue; }
    const blocks = list.split(/\r?\n\r?\n/).map((b) => Object.fromEntries(b.split(/\r?\n/).map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)])));
    const sourceRoot = resolve(blocks[0]?.worktree ?? '');
    for (const b of blocks) {
      const root = resolve(b.worktree ?? '');
      if (!norm(root).startsWith(norm(home) + sep) || !existsSync(root)) continue;
      const branch = b.branch?.replace(/^refs\/heads\//, '');
      // The chat records its checkout's folder; older checkouts were named
      // after the chat's id, so that is the fallback for ones no chat claims.
      const chat = lookup(root);
      const sessionId = chat?.id ?? basename(root);
      let dirtyCount = 0, unmergedCount = 0;
      try { dirtyCount = git(root, ['status', '--porcelain']).split('\n').filter(Boolean).length; } catch { /* keep 0 */ }
      try { if (branch) unmergedCount = Number(git(sourceRoot, ['rev-list', '--count', `HEAD..${branch}`])) || 0; } catch { /* keep 0 */ }
      out.push({ root, sourceRoot, branch, sessionId, sessionTitle: chat?.title, running: !!chat?.running, dirtyCount, unmergedCount });
    }
  }
  return out;
}

/**
 * Remove a chat's worktree folder. Git itself refuses when it has uncommitted
 * or untracked changes, and the branch is deleted only when it is fully merged,
 * so no work is lost; the chat restores its checkout if it is continued later.
 */
export function removeChatWorktree(settings: AppSettings, root: string, lookup: (worktreeRoot: string) => { id: string; title: string; running: boolean } | null): { branchDeleted: boolean } {
  const entry = listChatWorktrees(settings, lookup).find((w) => norm(w.root) === norm(root));
  if (!entry) throw new Error('That folder is not a chat worktree of a configured project.');
  if (entry.running) throw new Error('This chat is running. Stop it before removing its worktree.');
  if (entry.dirtyCount) throw new Error(`This worktree has ${entry.dirtyCount} uncommitted change${entry.dirtyCount === 1 ? '' : 's'}. Commit or discard them first.`);
  try { git(entry.sourceRoot, ['worktree', 'remove', entry.root]); }
  catch (error) {
    // On Windows Git deletes the files, then fails to delete a folder that a
    // terminal or editor still has open. Once Git has let go of the worktree,
    // that empty folder is harmless: the chat reuses it if it is continued.
    gitOk(entry.sourceRoot, ['worktree', 'prune']);
    const released = !git(entry.sourceRoot, ['worktree', 'list', '--porcelain']).split(/\r?\n/)
      .some((l) => l.startsWith('worktree ') && norm(l.slice(9)) === norm(entry.root));
    if (!released) throw new Error(`Git could not remove the worktree: ${String((error as { stderr?: unknown }).stderr ?? error).trim()}`);
  }
  const branchDeleted = !!entry.branch && gitOk(entry.sourceRoot, ['branch', '-d', entry.branch]);
  return { branchDeleted };
}

/**
 * Remove the chat worktrees whose branch's PR has merged. Squash merges leave
 * the branch "unmerged" to Git, so the PR's state (from GitHub) is what says
 * the work landed; that is also why the branch is force-deleted here, once its
 * PR is known merged. Anything with uncommitted or untracked files, a running
 * chat, or a PR that is not merged is left alone, as is any lookup that fails.
 * Never throws: one stuck worktree does not stop the others.
 */
export async function removeMergedChatWorktrees(
  settings: AppSettings,
  lookup: (worktreeRoot: string) => { id: string; title: string; running: boolean } | null,
  prState: (cwd: string, branch: string) => Promise<'open' | 'closed' | 'merged' | null>,
): Promise<Array<{ root: string; branch: string; sessionId: string }>> {
  if (settings.gitManagement?.removeMerged === false) return [];
  const removed: Array<{ root: string; branch: string; sessionId: string }> = [];
  for (const w of listChatWorktrees(settings, lookup)) {
    if (!w.branch || w.running || w.dirtyCount) continue;
    let state: 'open' | 'closed' | 'merged' | null = null;
    try { state = await prState(w.root, w.branch); } catch { continue; }
    if (state !== 'merged') continue;
    // Re-check right before removing: the chat may have started a turn or
    // edited a file while GitHub was being asked.
    if (lookup(w.root)?.running) continue;
    try { if (git(w.root, ['status', '--porcelain'])) continue; } catch { continue; }
    try { removeChatWorktree(settings, w.root, lookup); } catch { continue; }
    gitOk(w.sourceRoot, ['branch', '-D', w.branch]);
    removed.push({ root: w.root, branch: w.branch, sessionId: w.sessionId });
  }
  return removed;
}

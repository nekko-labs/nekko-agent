/** Workspace folders + codebase index types. */

import type { PrInfo } from './pr.js';

export interface WorkspaceFolder {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  /**
   * Shell command run in each new chat worktree of this project before the
   * chat's first turn, e.g. `npm install`. Its output goes to the chat's Agent
   * commands terminal; a failure is reported to the chat rather than stopping it.
   */
  worktreeSetup?: string;
}

/**
 * The comparable form of a folder path: no trailing separator, one kind of
 * separator, and case-folded where the filesystem ignores case (a Windows
 * drive path or a UNC share). `C:\code`, `c:\code\` and `C:/code` are one
 * folder; `/home/a` and `/home/A` stay two.
 */
export function folderPathKey(p: string): string {
  const raw = p.trim();
  const windows = /^[a-zA-Z]:([\\/]|$)/.test(raw) || /^\\\\/.test(raw);
  // A drive root keeps its separator: `C:` alone means "the current folder on C".
  const trimmed = windows && /^[a-zA-Z]:[\\/]*$/.test(raw) ? `${raw.slice(0, 2)}\\` : raw.replace(/(?<=.)[\\/]+$/, '');
  return windows ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
}

/** Whether two folder paths name the same folder. */
export function sameFolderPath(a: string, b: string): boolean {
  return folderPathKey(a) === folderPathKey(b);
}

/**
 * One entry per folder: later entries naming a folder already listed are
 * dropped, and `aliases` maps each dropped id to the one kept so references can
 * follow. Order is otherwise preserved.
 */
export function uniqueFolders<T extends { id: string; path: string }>(folders: T[]): { folders: T[]; aliases: Record<string, string> } {
  const seen = new Map<string, string>();
  const aliases: Record<string, string> = {};
  const out: T[] = [];
  for (const f of folders) {
    const key = folderPathKey(f.path);
    const kept = seen.get(key);
    if (kept) { if (kept !== f.id) aliases[f.id] = kept; continue; }
    seen.set(key, f.id);
    out.push(f);
  }
  return { folders: out, aliases };
}

/** One chat's isolated checkout, as Settings > Git management lists it. */
export interface ChatWorktreeInfo {
  /** The linked worktree's folder. */
  root: string;
  /** The repository's main checkout, which owns the worktree. */
  sourceRoot: string;
  branch?: string;
  /** The chat that owns it, read from the chat's own record of its checkout (older folders were named after the chat's id). */
  sessionId: string;
  /** Undefined when the chat has been deleted. */
  sessionTitle?: string;
  /** True while the chat is mid-turn; removal is refused then. */
  running: boolean;
  /** Changed and untracked files; Git refuses to remove a dirty worktree. */
  dirtyCount: number;
  /** Commits on the branch that the main checkout's HEAD does not contain. */
  unmergedCount: number;
}

/**
 * The git position of a workspace folder, as the sidebar states it.
 *
 * Deliberately the handful of facts a card can show in one line rather than a
 * full status: which branch the work is on, whether it has uncommitted changes,
 * and how far it has drifted from its upstream. A folder that is not a
 * repository is a real answer (`repo: false`), not an error, because plenty of
 * workspaces are just folders.
 */
export interface GitStatus {
  workspaceId: string;
  /** False when the folder is not inside a git repository at all. */
  repo: boolean;
  /** Current branch, or undefined on a detached HEAD. */
  branch?: string;
  /** Short commit sha, which is all a detached HEAD has to identify itself. */
  head?: string;
  /** Number of files with uncommitted modifications (staged or not). */
  dirtyCount: number;
  /** Commits ahead of the tracking branch, when there is one. */
  ahead: number;
  /** Commits behind the tracking branch, when there is one. */
  behind: number;
  /**
   * Set when the folder is a *linked* worktree (`git worktree add`) rather than
   * the repository's main checkout, which is how two agents work one repo
   * without trampling each other. `name` is the worktree folder's name.
   */
  worktree?: { name: string; path: string };
  /**
   * The pull request for this branch, when `gh` can see one. This is the PR
   * the work is going into, which is a different thing from the PRs a chat
   * happens to have mentioned.
   */
  pr?: PrInfo;
  /** Epoch ms this was read, so the UI can age it out. */
  updatedAt: number;
}

export interface IndexedFile {
  path: string;
  /** Relative to its workspace root. */
  relPath: string;
  sizeBytes: number;
  language?: string;
  /** Code symbols discovered by the lightweight outline parser. */
  symbols: CodeSymbol[];
}

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'method' | 'export';
  line: number;
}

export interface IndexStatus {
  workspaceId: string;
  fileCount: number;
  symbolCount: number;
  /** 0..1 */
  progress: number;
  state: 'idle' | 'indexing' | 'ready' | 'error';
  updatedAt: number;
}

export interface SearchHit {
  path: string;
  relPath: string;
  line: number;
  text: string;
}

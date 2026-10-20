/**
 * Git in a workspace's folder (IO-33 FA-2): the shapes the `git:*` channels
 * answer with. The engine is the daemon's (crates/nekko-workspace/src/gitops.rs);
 * the desktop can call it now and the phone will, through its access gate.
 *
 * Every call takes a workspace id first: a saved folder's id, or
 * `session:<chatId>` for a chat's own checkout (its worktree when isolated).
 * Paths are relative to that folder and may not leave it. Reads reject with
 * git's message; changes answer `{ ok: false, message }` when git refuses, and
 * reject only for a bad argument (an escaping path, an option as a revision,
 * an empty commit message).
 */

import type { PrFileStatus } from './pr.js';

/** A PR file's status, plus `conflicted` for an unmerged file mid-merge. */
export type GitFileStatus = PrFileStatus | 'conflicted';

/** One changed file without its patch (compare lists files this way). */
export interface GitFileStat {
  path: string;
  /** Prior path for renames and copies. */
  oldPath?: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  /** Binary files are summarized: no patch and no line counts. */
  binary?: boolean;
}

/** One file of a diff, shaped like `PrDiffFile`. */
export interface GitDiffFile extends GitFileStat {
  /** Unified-diff hunks from the first `@@`, capped at 500 lines. */
  patch: string;
  /** This file's patch was cut (too long, or the whole diff hit its byte cap). */
  truncated?: boolean;
  /** A new file git does not track yet (working-tree diffs only). */
  untracked?: boolean;
}

export interface GitDiff {
  files: GitDiffFile[];
  /** Some file was cut, or there were more than 300 files. */
  truncated: boolean;
}

export interface GitDiffOptions {
  /** Only this file or folder. */
  path?: string;
  /** The index against HEAD (or `base`) instead of the working tree. */
  staged?: boolean;
  /** Compare against this branch, tag or commit instead of the index. */
  base?: string;
}

export interface GitLogOptions {
  /** Start here instead of HEAD. */
  ref?: string;
  /** 1 to 200; 50 when omitted. */
  limit?: number;
  skip?: number;
  /** Only commits touching this path. */
  path?: string;
}

export interface GitCommit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, ISO 8601. */
  date: string;
  subject: string;
}

export interface GitCommitDetail {
  commit: GitCommit & { body: string };
  /** A merge shows its changes against its first parent. */
  files: GitDiffFile[];
  truncated: boolean;
}

export interface GitBranch {
  /** `main` for a local branch, `origin/main` for a remote one. */
  name: string;
  /** Short sha of the tip. */
  sha: string;
  /** Committer date of the tip, ISO 8601. */
  date: string;
  subject: string;
  /** Local branches only. */
  current?: boolean;
  /** Local branches with an upstream: its name and the distance from it. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** The upstream was deleted on the remote. */
  gone?: boolean;
  /** Remote branches only: the remote's name. */
  remote?: string;
}

export interface GitBranches {
  /** The checked-out branch; null on a detached HEAD or with no commits. */
  current: string | null;
  detached: boolean;
  /** Short sha of HEAD, when there is a commit. */
  head?: string;
  /** What `origin/HEAD` points at, when the remote says. */
  defaultBranch: string | null;
  local: GitBranch[];
  remote: GitBranch[];
}

export interface GitCompare {
  base: string;
  head: string;
  mergeBase?: string;
  /** Commits on `head` not on `base`. */
  ahead: number;
  /** Commits on `base` not on `head`. */
  behind: number;
  /** The commits on `head` only, newest first, at most 200. */
  commits: GitCommit[];
  /** Files changed on `head` since it split from `base`, as a PR shows them. */
  files: GitFileStat[];
  truncated: boolean;
}

/** What a git change answers. `ok: false` carries git's own reason. */
export interface GitResult {
  ok: boolean;
  message: string;
}

export interface GitCommitOptions {
  message: string;
  /** Not supported: true is refused. */
  amend?: false;
  /** Not supported: true is refused. */
  allowEmpty?: false;
}

export interface GitCommitResult extends GitResult {
  commit?: GitCommit;
  branch?: string;
}

export interface GitCommitMessage {
  /** Subject, then a blank line and a body when the change needs one. */
  message: string;
  /** The staged diff was cut before the model saw it. */
  inputTruncated: boolean;
}

export interface GitPushOptions {
  /** With no upstream yet: push to origin under the same name and track it. */
  setUpstream?: boolean;
}

export interface GitPushResult extends GitResult {
  branch?: string;
  remote?: string;
  /** `origin/main`. */
  upstream?: string;
}

export interface GitSwitchOptions {
  /** Create the branch from HEAD. */
  create?: boolean;
}

export interface GitSwitchResult extends GitResult {
  branch?: string;
}

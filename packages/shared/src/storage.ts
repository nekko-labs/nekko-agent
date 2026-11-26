/** Settings → Storage: where Nekko's disk goes (nekkod `storage:*`, crates/nekkod/src/storage.rs). */

export type StorageCategoryId = 'worktrees' | 'runners' | 'models' | 'history' | 'caches' | 'other';

export interface StorageCategory {
  id: StorageCategoryId;
  /** `null` until first measured. */
  bytes: number | null;
  /** `elsewhereBytes`: the part on another disk, left out of this disk's bar. */
  detail?: { buildOutputBytes?: number; count?: number; picturesBytes?: number; elsewhere?: boolean; elsewhereBytes?: number };
}

export interface DiskSpace { total: number; free: number }

export interface StorageUsage {
  /** When the last walk finished (ms), `null` before the first. */
  measuredAt: number | null;
  measuring: boolean;
  disk: DiskSpace | null;
  /** Always all six, in this order: worktrees, runners, models, history, caches, other. */
  categories: StorageCategory[];
  /** Each worktree's size from the last walk, by root. */
  worktreeBytes: Record<string, number>;
}

/** Why "Remove idle worktrees" keeps a worktree (decision 0122). */
export type KeptReason = 'recent' | 'dirty' | 'unpushed' | 'running' | 'locked' | 'open' | 'ignored';

export interface IdleWorktree {
  root: string;
  projectName?: string;
  branch?: string | null;
  head: string;
  /** From the last measurement; `null` when not measured yet. */
  bytes: number | null;
  /** Every commit is on a remote, or its branch's PR merged at this head. */
  reason: 'pushed' | 'merged';
}

export interface IdlePreview { idle: IdleWorktree[]; kept: Partial<Record<KeptReason, number>> }

export interface RemoveWorktreesResult { removed: string[]; freed: number; failed: { root: string; error: string }[] }

/** A folder in `<data>/runners` holding a VM image (`storage:runnerImages`). */
export interface RunnerImage {
  /** Path relative to the runners folder, e.g. `images/default` or `old-image-tart-2026-10-29`. */
  name: string;
  bytes: number;
  modifiedAt: number;
  /** Runners use it, a build can resume from it, or a runner names it: never removable. */
  inUse: boolean;
  kind: 'macos' | 'linux' | 'cache' | 'unfinished' | 'previous' | 'other';
}

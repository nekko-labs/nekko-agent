/** Settings → Storage: where Nekko's disk goes (nekkod `storage:*`, crates/nekkod/src/storage.rs). */

export type StorageCategoryId = 'worktrees' | 'runners' | 'models' | 'history' | 'caches' | 'other';

export interface StorageCategory {
  id: StorageCategoryId;
  /** `null` until first measured. */
  bytes: number | null;
  detail?: { buildOutputBytes?: number; count?: number; picturesBytes?: number; elsewhere?: boolean };
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

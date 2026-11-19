/**
 * Persistent on-disk thumbnails for Library files (#3043). The main process
 * manages a bounded LRU store under `{userData}/library-thumbs/`; the
 * renderer reads and writes through these channels.
 *
 * Channels the host answers itself; they never reach the engine.
 */

/** IPC channels the main process registers (see `main/libraryThumbnails.ts`). */
export const LIBRARY_THUMBNAIL_CHANNELS = {
  /** Get a cached thumbnail for a path at a given revision. Returns null if not cached. */
  get: 'libraryThumb:get',
  /** Store a thumbnail for a path at a given revision. */
  put: 'libraryThumb:put',
  /** Render a served HTML URL in a hidden off-screen window and return a PNG thumbnail. */
  capture: 'libraryThumb:capture',
} as const;

/** A revision token that changes when a file's content changes. */
export type ThumbnailRevision = string | number;

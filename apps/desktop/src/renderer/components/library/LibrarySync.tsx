import React, { useEffect, useMemo, useState } from 'react';
import type { CloudStatus, LibrarySyncStatus } from '@nekko-agent/shared';
import { StatusDot } from '../primitives/Badge.js';
import type { ArtifactEntry } from '../../artifactsIndex.js';
import { syncFilesOf, syncKey, syncLabel, syncSummary, type TileSync } from './librarySyncState.js';

/** How long Library's list has to sit still before the engine is told about it. */
const REPORT_MS = 800;

/**
 * Library sync for this view: follows the engine's cloud status, and tells it
 * which files Library lists here whenever that list changes (only while Library
 * sync is open to the account). Returns the status's `library` part, or null.
 *
 * `getRevision` maps an entry to the revision token used to key its disk
 * thumbnail (the same value passed to `LibraryFileThumbnail`). When provided,
 * the hook attaches each file's current thumbnail to the payload so the engine
 * can embed it in the sealed record for other computers (#3044).
 */
export function useLibrarySync(
  entries: readonly ArtifactEntry[] | null,
  getRevision?: (e: ArtifactEntry) => string | number,
): LibrarySyncStatus | null {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  useEffect(() => {
    let live = true;
    window.nekko?.cloudStatus?.().then((s) => { if (live) setStatus(s); }).catch(() => {});
    const off = window.nekko?.onCloudStatus?.((s) => { if (live) setStatus(s); });
    return () => { live = false; off?.(); };
  }, []);
  const library = status?.library ?? null;
  const open = !!library;
  const files = useMemo(() => syncFilesOf(entries ?? []), [entries]);
  const key = syncKey(files);
  useEffect(() => {
    if (!open || !files.length || !window.nekko?.librarySync) return;
    const timer = setTimeout(async () => {
      try {
        // Attach cached thumbnails to the files so the engine can embed them in sealed records (#3044).
        // This is best-effort: if thumbnails aren't cached yet they'll be included next time.
        let filesWithThumbs = files;
        if (window.nekko?.libraryThumbGet && getRevision && entries) {
          const entryMap = new Map(
            (entries as ArtifactEntry[]).filter((e) => e.source !== 'cloud').map((e) => [e.path, e]),
          );
          const thumbed = await Promise.all(
            files.map(async (f) => {
              const e = entryMap.get(f.path);
              if (!e) return f;
              const rev = getRevision(e);
              const thumbnailData = await window.nekko.libraryThumbGet!(f.path, rev).catch(() => null);
              return thumbnailData ? { ...f, thumbnailData } : f;
            }),
          );
          filesWithThumbs = thumbed;
        }
        const s = await window.nekko.librarySync(filesWithThumbs);
        setStatus(s);
      } catch { /* non-fatal */ }
    }, REPORT_MS);
    return () => clearTimeout(timer);
    // `key` stands for `files`. `getRevision` and `entries` are captured at call time
    // inside the async callback, so they don't need to be in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);
  return library;
}

/**
 * A file's cloud, for the top-right corner of its tile and the end of its row:
 * a check when it is backed up, an arrow while it waits or uploads, a slash
 * when it isn't backed up, and a down arrow for another computer's file.
 */
export function LibrarySyncGlyph({ state, device, className = '' }: { state: TileSync; device?: string; className?: string }) {
  const label = syncLabel(state, device);
  const mark = state === 'synced'
    ? <path d="M9.4 14.2l1.9 1.9 3.4-3.6" />
    : state === 'syncing' || state === 'pending'
      ? <path d="M12 16.6v-4.8M9.9 13.7 12 11.6l2.1 2.1" />
      : state === 'remote'
        ? <path d="M12 11.4v4.8M9.9 14.3 12 16.4l2.1-2.1" />
        : <path d="M4.5 4.5l15 15" />;
  return (
    <span className={`library-sync ${className}`} data-library-sync={state} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 11a3.5 3.5 0 0 1-.5 7H7Z" />
        {mark}
      </svg>
    </span>
  );
}

/** The header's dot and word for Library's sync as a whole; the detail behind a hover. */
export function LibrarySyncSummary({ library, entries }: { library: LibrarySyncStatus | null; entries: readonly ArtifactEntry[] }) {
  const summary = syncSummary(library, entries);
  if (!summary) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-2xs text-ink-soft" data-library-sync-summary={summary.tone} title={summary.detail}>
      <StatusDot tone={summary.tone} size={6} />
      <span className={summary.tone === 'warning' ? 'text-warning-text' : undefined}>{summary.word}</span>
    </span>
  );
}

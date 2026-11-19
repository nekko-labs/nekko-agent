import React, { useEffect, useState } from 'react';
import { isServableHtml } from '@nekko-agent/shared';
import type { ArtifactKind } from '../../artifactsIndex.js';
import { LibraryFileIcon } from './LibraryFileIcon.js';
import { thumbnailKind } from './thumbnailCache.js';

/**
 * A small thumbnail for a Library row (#3043). For local files it reads the
 * on-disk cache on mount; for remote files from Nekko Cloud it uses the
 * thumbnail data embedded in the sealed record (#3044). Falls back to the kind
 * icon in both cases when no thumbnail is available.
 */
export function LibraryFileThumbnail({ kind, path, revision, thumbnailData, className = '' }: {
  kind: ArtifactKind;
  path: string;
  /** The file's revision token (session updatedAt or file at timestamp). */
  revision?: string | number;
  /**
   * A pre-fetched thumbnail data URL for another computer's file, from the
   * sealed Library record. When provided, the disk cache is not consulted
   * (#3044).
   */
  thumbnailData?: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(thumbnailData ?? null);

  // For local files: read from the on-disk cache when no pre-fetched thumbnail is available.
  const canCheck = !thumbnailData && !!window.nekko?.libraryThumbGet && revision !== undefined;
  const hasKind = !!thumbnailKind(path) || isServableHtml(path);

  useEffect(() => {
    // If a pre-fetched thumbnail was supplied, use it directly (remote files, #3044).
    if (thumbnailData !== undefined) { setUrl(thumbnailData || null); return; }
    if (!canCheck || !hasKind) return;
    let live = true;
    window.nekko.libraryThumbGet!(path, revision!).then((cached) => {
      if (live) setUrl(cached);
    }).catch(() => {});
    return () => { live = false; };
  }, [canCheck, hasKind, path, revision, thumbnailData]);

  if (url) {
    return (
      <span className={`library-file-icon ${className}`} aria-hidden="true">
        <img src={url} alt="" className="h-full w-full rounded-[inherit] object-cover object-top" decoding="async" draggable={false} />
      </span>
    );
  }
  return <LibraryFileIcon kind={kind} className={className} />;
}

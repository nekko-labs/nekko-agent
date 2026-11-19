import React, { useEffect, useState } from 'react';
import { isServableHtml } from '@nekko-agent/shared';
import type { ArtifactKind } from '../../artifactsIndex.js';
import { LibraryFileIcon } from './LibraryFileIcon.js';
import { thumbnailKind } from './thumbnailCache.js';

/**
 * A small thumbnail for a Library row (#3043). Reads the on-disk cache on
 * mount; if the thumbnail is there it shows the actual file content, otherwise
 * it falls back to the kind icon (same visual as before). No file reads happen
 * here — only a cache lookup.
 */
export function LibraryFileThumbnail({ kind, path, revision, className = '' }: {
  kind: ArtifactKind;
  path: string;
  /** The file's revision token (session updatedAt or file at timestamp). */
  revision?: string | number;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const canCheck = !!window.nekko?.libraryThumbGet && revision !== undefined;
  const hasKind = !!thumbnailKind(path) || isServableHtml(path);

  useEffect(() => {
    if (!canCheck || !hasKind) return;
    let live = true;
    window.nekko.libraryThumbGet!(path, revision!).then((cached) => {
      if (live) setUrl(cached);
    }).catch(() => {});
    return () => { live = false; };
  }, [canCheck, hasKind, path, revision]);

  if (url) {
    return (
      <span className={`library-file-icon ${className}`} aria-hidden="true">
        <img src={url} alt="" className="h-full w-full rounded-[inherit] object-cover object-top" decoding="async" draggable={false} />
      </span>
    );
  }
  return <LibraryFileIcon kind={kind} className={className} />;
}

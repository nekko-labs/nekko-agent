import React from 'react';
import type { ArtifactKind } from '../../artifactsIndex.js';
import { BranchIcon, FileIcon, GlobeIcon, GridIcon, ListIcon, PhotoIcon } from '../../icons.js';
import { KIND_COLOR } from './ArtifactPreview.js';

/** Row-size symbols, not miniatures of the large placeholder illustrations. No file reads. */
export function LibraryFileIcon({ kind, className = '' }: { kind: ArtifactKind; className?: string }) {
  const Icon = { doc: FileIcon, web: GlobeIcon, design: GridIcon, diagram: BranchIcon, data: ListIcon, office: FileIcon, image: PhotoIcon }[kind];
  return <span className={`library-file-icon ${className}`} data-library-file-icon={kind} aria-hidden="true" style={{ '--file-color': KIND_COLOR[kind] } as React.CSSProperties}>
    <Icon className="h-4 w-4" />
  </span>;
}

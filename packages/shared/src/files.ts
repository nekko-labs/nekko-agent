/** Direct file-system access for the in-app file viewer/editor and explorer. */

/** One entry in a directory listing. */
export interface DirEntry {
  name: string;
  /** Absolute path. */
  path: string;
  /** True for directories. */
  dir: boolean;
}

/** A file's text content for the viewer/editor. */
export interface FileContent {
  content: string;
  /** Bounded, validated raster image for explicit user-initiated previews. */
  imageDataUrl?: string;
  /** True if the file was longer than the read cap and content is partial. */
  truncated: boolean;
  /** True if the file looks binary (not shown as text). */
  binary: boolean;
}

/**
 * A remote photo fetched by the host for the chat (`image:fetch`): only public
 * http(s) addresses, size-capped, and the bytes sniffed to a raster type, so
 * the renderer only ever mounts an inert data URL.
 */
export interface RemoteImage {
  /** `data:image/<png|jpeg|gif|webp|avif>;base64,...` */
  dataUrl: string;
  mime: string;
  bytes: number;
  /** Where the image actually came from, after redirects. */
  finalUrl: string;
}

/**
 * Files in one folder for callers that must not reach outside it (IO-33
 * FA-1: `files:list`, `files:search`, `files:read`, `files:write`), served by
 * nekkod (crates/nekko-workspace/src/scoped.rs). The caller names the folder
 * by chat or saved-folder id, never by path; every path is relative to it and
 * `/`-separated. `..`, absolute paths and symlinks that resolve outside are
 * refused, and files that may hold secrets (`.env`, `.ssh/`, keys, git
 * credentials) are counted, never named, read or written. Refusals are
 * errors whose message starts with a {@link ScopedFileError} code.
 */
export type ScopedRoot = { sessionId: string; workspaceId?: string } | { workspaceId: string; sessionId?: undefined };

export type ScopedFileError =
  | 'outside-root'
  | 'secret-file'
  | 'not-found'
  | 'not-a-file'
  | 'not-a-folder'
  | 'no-folder'
  | 'binary'
  | 'too-large'
  | 'bad-request'
  | 'io';

export interface ScopedEntry {
  name: string;
  /** Relative to the root. */
  path: string;
  dir: boolean;
  /** Bytes, files only. */
  size?: number;
  /** Epoch ms. */
  mtime?: number;
  /** A symlink that resolves inside the root. */
  link?: true;
}

export interface ScopedListing {
  /** The folder listed, relative to the root ('' for the root). */
  path: string;
  /** Folders first, then files, at most 500. */
  entries: ScopedEntry[];
  /** Entries before the cap. */
  total: number;
  truncated: boolean;
  /** Entries left out because they may hold secrets. */
  hiddenSecrets: number;
  /** Links left out because they lead outside the root, or nowhere. */
  hiddenLinks: number;
}

export interface ScopedSearch {
  /** Best first: exact name, name prefix, name contains, path contains. */
  hits: { path: string; name: string }[];
  /** More files matched than the limit. */
  truncated: boolean;
  /** False when the search stopped looking (50,000 files). */
  complete: boolean;
}

export interface ScopedFile {
  path: string;
  name: string;
  size: number;
  mtime: number | null;
  /** sha256 of all the file's bytes (null past 64 MB); send it back as `expectHash`. */
  hash: string | null;
  kind: 'text' | 'image' | 'binary';
  /** Text, up to `maxBytes` (default 256 KB, at most 1 MB). */
  content?: string;
  truncated: boolean;
  /** A syntax-colouring hint (highlight.js names). */
  language?: string;
  markdown?: boolean;
  /** Images up to 2 MB. */
  imageDataUrl?: string;
  mime?: string;
  /** Whole UTF-8 text under 1 MB: a save may replace it. */
  editable: boolean;
}

export type ScopedWriteResult =
  | { ok: true; hash: string; size: number; mtime: number | null }
  /** The file changed since it was read (or exists when none was expected); `hash` is its current hash. */
  | { ok: false; error: 'conflict'; hash: string | null };

/** A file the agent changed this session, original vs current, for diff/approve. */
export interface FileChange {
  path: string;
  /** Content before the agent's first edit this session ('' if newly created). */
  original: string;
  /** Content on disk now. */
  current: string;
}

/**
 * An inline comment left on a line of a file in the editor. The agent picks it
 * up when the user chooses "Add to prompt" or "Run now"; it persists as a gutter
 * marker until resolved.
 */
export interface LineComment {
  id: string;
  /** Absolute file path the comment is anchored to. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The line's text when the comment was made (context for the agent). */
  lineText: string;
  /** The user's comment. */
  comment: string;
  createdAt: number;
}

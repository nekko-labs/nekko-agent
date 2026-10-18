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

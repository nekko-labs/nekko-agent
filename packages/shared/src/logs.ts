/**
 * The computer's logs (IO-33 FA-5: `logs:list`, `logs:read`), served by
 * nekkod (crates/nekkod/src/logs.rs): the desktop app's log
 * (`<dataDir>/logs/app.log`), the engine's (`<dataDir>/logs/nekkod.log`) and
 * each chat's agent run log. Read only. Every line is passed through a secret
 * redactor before it leaves the daemon, and a search matches the redacted text.
 */

export interface LogInfo {
  /** `app`, `daemon`, or `agent:<sessionId>`. */
  id: string;
  title: string;
  kind: 'app' | 'daemon' | 'agent';
  /** Bytes across the live file and its rotated copies. */
  size: number;
  /** Epoch ms, null when the log has no file yet. */
  updatedAt: number | null;
  sessionId?: string;
}

export interface LogReadOptions {
  /** How far back to read: default 64 KB (1 MB with `query`), at most 1 MB (8 MB with `query`). */
  tailBytes?: number;
  /** Case-insensitive text to find; returns matching lines instead of the tail. */
  query?: string;
  /** Matching lines returned with `query`: default 200, at most 1000. */
  maxMatches?: number;
}

export interface LogRead {
  id: string;
  size: number;
  updatedAt: number | null;
  /** Older content exists before the window read. */
  truncated: boolean;
  /** The redacted tail, from a line start (without `query`). */
  text?: string;
  query?: string;
  /** Redacted matching lines, numbered from the start of the log (with `query`). */
  matches?: { line: number; text: string }[];
  moreMatches?: boolean;
}

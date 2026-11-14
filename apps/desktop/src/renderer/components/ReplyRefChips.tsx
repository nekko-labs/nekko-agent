import React from 'react';
import { FileTypeIcon } from '../fileIcons.js';
import { NO_REFS, issueRefUrl, resolveFileRef, type ReplyRefs } from '../replyRefs.js';
import { useStore } from '../store.js';
import { IssueLinkChip, PrLinkChip } from './PrLinkChip.js';

/** The chat's repo and touched files, for the reply references below. */
export const MarkdownRefs = React.createContext<ReplyRefs>(NO_REFS);

/** Shared with the session and Sandbox contexts in Markdown.tsx, passed in to avoid a cycle. */
type Where = { basePath?: string; sessionId?: string; sandbox: boolean };

const CHIP = 'file-ref-chip inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border border-line px-1.5 align-middle leading-4 hover:bg-surface-2 focus-visible:outline focus-visible:outline-accent';

/**
 * A code reference (`RootView.swift:164-166`) as a chip: the file's type, its
 * name and the lines, with the full path on hover. Opens the file in the
 * originating chat. A reference it cannot place (a bare name the agent never
 * touched, no chat folder, Sandbox) stays as the reply wrote it.
 */
export function FileRefChip({ file, line, output = false, where, children }: { file: string; line?: string; output?: boolean; where: Where; children: React.ReactNode }) {
  const refs = React.useContext(MarkdownRefs);
  const path = where.sandbox ? null : resolveFileRef(file, refs, where.basePath, output);
  if (!path) return <>{children}</>;
  const name = path.split(/[\\/]/).pop() || file;
  const lines = line ? (line.includes('-') ? `lines ${line}` : `line ${line}`) : '';
  return (
    <button type="button" className={CHIP} data-file-ref={path} title={lines ? `${path}, ${lines}` : path}
      aria-label={`Open ${name}${lines ? `, ${lines}` : ''}`}
      onClick={() => useStore.getState().openFilePane(path, where.sessionId)}>
      <FileTypeIcon name={name} size={14} />
      <span className="flex min-w-0 font-mono text-xs">
        <span className="min-w-0 truncate text-ink">{name}</span>
        {line && <span className="shrink-0 text-ink-soft">:{line}</span>}
      </span>
    </button>
  );
}

/**
 * `#2480`, `PR #2636`, `issue #12` or `owner/repo#5` as the PR (or issue) chip
 * with its live state. A bare `#N` needs the chat's repo; without one, or for
 * a one-digit bare number (`step #3`), it stays text.
 */
export function IssueRefChip({ number, slug, issue, bare, children }: { number: string; slug?: string; issue: boolean; bare: boolean; children: React.ReactNode }) {
  const refs = React.useContext(MarkdownRefs);
  const url = bare && !slug && number.length < 2 ? null : issueRefUrl(number, slug, issue, refs);
  if (!url) return <>{children}</>;
  const label = slug ? `${slug}#${number}` : `#${number}`;
  return issue ? <IssueLinkChip href={url} label={label} /> : <PrLinkChip href={url} label={label} />;
}

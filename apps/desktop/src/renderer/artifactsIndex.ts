import type { Session, SessionSummary } from '@nekko-agent/shared';
import { chatArtifacts } from './chatArtifacts.js';

/**
 * Everything agents have produced, across chats, for the Artifacts tab: the
 * documents a reply links to (the same cards a reply shows) and the files the
 * agent itself wrote with `write_file`, grouped by what kind of thing they are.
 *
 * Worked out in the renderer from transcripts, so nothing new is stored and the
 * host keeps one source of truth: the chat. Only paths are listed; a file that
 * has since been deleted still shows and simply fails to open.
 */

export type ArtifactKind = 'doc' | 'web' | 'design' | 'diagram' | 'data' | 'office' | 'image';

export const ARTIFACT_KINDS: ReadonlyArray<{ id: ArtifactKind; label: string }> = [
  { id: 'doc', label: 'Documents' },
  { id: 'web', label: 'Web pages' },
  { id: 'design', label: 'Designs' },
  { id: 'diagram', label: 'Diagrams' },
  { id: 'data', label: 'Data' },
  { id: 'office', label: 'Office files' },
  { id: 'image', label: 'Images' },
];

/** Extensions that count as an output worth listing, by kind. Source code is deliberately absent. */
const KIND_BY_EXT: Record<string, ArtifactKind> = {
  md: 'doc', markdown: 'doc', txt: 'doc', pdf: 'doc',
  html: 'web', htm: 'web',
  svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  mmd: 'diagram', mermaid: 'diagram', excalidraw: 'diagram', drawio: 'diagram',
  csv: 'data', json: 'data', tsv: 'data',
  doc: 'office', docx: 'office', xls: 'office', xlsx: 'office', ppt: 'office', pptx: 'office',
};

/** Folders whose files are designs, whatever their extension (the project convention). */
const DESIGN_DIR = /(?:^|\/)(?:nekko-designs|designs?|mockups?|prototypes?)\//i;
/** Files that are part of an app being built, not an output: skip them even when an agent writes one. */
const NOT_AN_OUTPUT = /(?:^|\/)(?:node_modules|\.git|dist|build|out|target|src|app|apps|packages|lib|public|test|tests|\.shots|\.github)\//i;
const NOT_AN_OUTPUT_NAME = /^(?:package(?:-lock)?\.json|tsconfig.*\.json|readme\.md|changelog\.md|agents\.md|claude\.md|spec\.md|tasks\.md|license(?:\.md)?|\.?.*rc\.json)$/i;

export function artifactKind(path: string): ArtifactKind | null {
  const p = path.replaceAll('\\', '/');
  const ext = p.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  const kind = KIND_BY_EXT[ext];
  if (!kind) return null;
  if (DESIGN_DIR.test(p) && (kind === 'web' || kind === 'image')) return 'design';
  return kind;
}

export interface ArtifactEntry {
  /** Absolute (or project-resolved) path, the key. */
  path: string;
  title: string;
  filename: string;
  kind: ArtifactKind;
  sessionId: string;
  sessionTitle: string;
  /** When the message that produced or linked it was written. */
  at: number;
  /** Linked from a reply, or written by the agent and never linked. */
  source: 'linked' | 'written';
}

function normalize(path: string): string {
  const parts: string[] = [];
  const p = path.replaceAll('\\', '/');
  for (const part of p.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `${p.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}

function titleFor(path: string): string {
  const parts = path.split('/');
  const file = parts.at(-1) ?? path;
  const base = /^(?:readme|index)\./i.test(file) ? parts.at(-2) ?? file : file.replace(/\.[^.]+$/, '');
  return base.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * The artifacts one chat produced: links in its replies, then files it wrote
 * (only those that look like outputs). The newest mention of a path wins its
 * timestamp; a link's label wins over a written file's derived title.
 */
export function sessionArtifacts(session: Pick<Session, 'id' | 'title' | 'messages'>, basePath?: string): ArtifactEntry[] {
  const out = new Map<string, ArtifactEntry>();
  const put = (e: ArtifactEntry) => {
    const key = e.path.toLowerCase();
    const prev = out.get(key);
    if (!prev) { out.set(key, e); return; }
    out.set(key, { ...prev, at: Math.max(prev.at, e.at), ...(e.source === 'linked' ? { title: e.title, source: 'linked' as const } : {}) });
  };
  for (const m of session.messages) {
    if (m.role !== 'assistant') continue;
    for (const a of chatArtifacts(m.content, basePath)) {
      const kind = artifactKind(a.path);
      if (kind) put({ path: a.path, title: a.title, filename: a.filename, kind, sessionId: session.id, sessionTitle: session.title, at: m.createdAt, source: 'linked' });
    }
    for (const call of m.toolCalls ?? []) {
      if (call.name !== 'write_file' || typeof call.input?.path !== 'string') continue;
      const raw = call.input.path.trim();
      if (!raw) continue;
      const absolute = /^(?:[a-z]:[\\/]|\/)/i.test(raw);
      if (!absolute && !basePath) continue;
      const path = normalize(absolute ? raw : `${basePath}/${raw}`);
      const filename = path.split('/').pop() ?? path;
      const rel = basePath && path.toLowerCase().startsWith(normalize(basePath).toLowerCase()) ? path.slice(normalize(basePath).length) : path;
      if (NOT_AN_OUTPUT.test(rel) || NOT_AN_OUTPUT_NAME.test(filename)) continue;
      const kind = artifactKind(path);
      if (kind) put({ path, title: titleFor(path), filename, kind, sessionId: session.id, sessionTitle: session.title, at: m.createdAt, source: 'written' });
    }
  }
  return [...out.values()];
}

/** Chats worth scanning: top-level, real conversations, newest first. */
export function artifactCandidates(sessions: readonly SessionSummary[], limit = 60): SessionSummary[] {
  return sessions
    .filter((s) => !s.parentSessionId && !s.incognito && s.chatType !== 'image' && s.exchangeCount > 1)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** Group, newest first within a group, groups in the fixed kind order. Optional text filter on title, filename, chat. */
export function groupArtifacts(entries: readonly ArtifactEntry[], query = ''): Array<{ kind: (typeof ARTIFACT_KINDS)[number]; items: ArtifactEntry[] }> {
  const q = query.trim().toLowerCase();
  const shown = q
    ? entries.filter((e) => e.title.toLowerCase().includes(q) || e.filename.toLowerCase().includes(q) || e.sessionTitle.toLowerCase().includes(q) || e.path.toLowerCase().includes(q))
    : entries;
  return ARTIFACT_KINDS
    .map((kind) => ({ kind, items: shown.filter((e) => e.kind === kind.id).sort((a, b) => b.at - a.at) }))
    .filter((g) => g.items.length > 0);
}

/** One entry per path across chats: the newest chat that touched it owns it. */
export function mergeArtifacts(lists: ReadonlyArray<readonly ArtifactEntry[]>): ArtifactEntry[] {
  const out = new Map<string, ArtifactEntry>();
  for (const list of lists) for (const e of list) {
    const key = e.path.toLowerCase();
    const prev = out.get(key);
    if (!prev || e.at > prev.at) out.set(key, e);
  }
  return [...out.values()];
}

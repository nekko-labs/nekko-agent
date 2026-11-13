import type { Session, SessionSummary } from '@nekko-agent/shared';
import { chatArtifacts } from './chatArtifacts.js';

/**
 * Everything agents have produced, across chats, for Library: the documents a
 * reply links to (the same cards a reply shows) and the files the agent itself
 * wrote (`write_file`, or Claude Code's `Write`), grouped by what kind of thing
 * they are. The designs in each project's `nekko-designs/` folder join them,
 * whoever put them there.
 *
 * Worked out in the renderer from transcripts and a folder listing, so nothing
 * new is stored and the host keeps one source of truth: the chat. Only paths
 * are listed; a file that has since been deleted still shows and simply fails
 * to open.
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

/** The project folder agents and the Design tab keep designs in. */
export const DESIGNS_FOLDER = 'nekko-designs';
/** Folders whose files are designs, whatever their extension (the project convention). */
const DESIGN_DIR = /(?:^|\/)(?:nekko-designs|designs?|mockups?|prototypes?)\//i;
/** A file whose own name says it is a design: `login-mockup.html`, `pricing_wireframe.png`, `prototype.html`. */
const DESIGN_NAME = /(?:^|[-_. ])(?:designs?|mock-?ups?|mocks?|prototypes?|wireframes?|concepts?|canvas(?:es)?|artboards?)(?=[-_. ]|$)/i;
/** Tools that write a whole file, and the argument naming it: Nekko's own, and Claude Code's. */
const WRITE_TOOLS: Record<string, string> = { write_file: 'path', Write: 'file_path' };
/** Files that are part of an app being built, or an agent's own notes (`.claude/`), not an output: skip them even when an agent writes one. */
const NOT_AN_OUTPUT = /(?:^|\/)(?:node_modules|\.git|dist|build|out|target|src|app|apps|packages|lib|public|test|tests|\.shots|\.github|\.claude)\//i;
const NOT_AN_OUTPUT_NAME = /^(?:package(?:-lock)?\.json|tsconfig.*\.json|readme\.md|changelog\.md|agents\.md|claude\.md|spec\.md|tasks\.md|license(?:\.md)?|\.?.*rc\.json)$/i;

export function artifactKind(path: string): ArtifactKind | null {
  const p = path.replaceAll('\\', '/');
  const ext = p.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  const kind = KIND_BY_EXT[ext];
  if (!kind) return null;
  const name = p.split('/').pop() ?? '';
  if ((kind === 'web' || kind === 'image') && (DESIGN_DIR.test(p) || DESIGN_NAME.test(name.replace(/\.[^.]+$/, '')))) return 'design';
  return kind;
}

export interface ArtifactEntry {
  /** Absolute (or project-resolved) path, the key. */
  path: string;
  title: string;
  filename: string;
  kind: ArtifactKind;
  /** The chat it came from; empty for a design found in a project's designs folder. */
  sessionId: string;
  /** That chat's title; for a folder design, the project it sits in. */
  sessionTitle: string;
  /** When the message that produced or linked it was written; 0 when no chat mentioned it. */
  at: number;
  /** Linked from a reply, written by the agent and never linked, or found in a project's designs folder. */
  source: 'linked' | 'written' | 'folder';
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
      // A localhost preview server is not a file the chat produced.
      if (a.live) continue;
      const kind = artifactKind(a.path);
      if (kind) put({ path: a.path, title: a.title, filename: a.filename, kind, sessionId: session.id, sessionTitle: session.title, at: m.createdAt, source: 'linked' });
    }
    for (const call of m.toolCalls ?? []) {
      const named = Object.hasOwn(WRITE_TOOLS, call.name) ? call.input?.[WRITE_TOOLS[call.name]] : undefined;
      if (typeof named !== 'string') continue;
      const raw = named.trim();
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

/**
 * The designs sitting in a project's designs folder, from a listing of it (and
 * of its subfolders): pages and images only. No chat is attached, so they carry
 * the project's name instead.
 */
export function folderDesigns(project: string, files: ReadonlyArray<{ path: string; name: string }>): ArtifactEntry[] {
  const out: ArtifactEntry[] = [];
  for (const f of files) {
    const path = normalize(f.path);
    if (artifactKind(path) !== 'design') continue;
    out.push({ path, title: titleFor(path), filename: f.name, kind: 'design', sessionId: '', sessionTitle: project, at: 0, source: 'folder' });
  }
  return out;
}

/** How much of a designs folder Library lists: enough for a real project, bounded for a dumping ground. */
const FOLDER_LIMIT = { subfolders: 40, files: 300 };

/**
 * The files in a project's designs folder and one level of its subfolders
 * (`nekko-designs/login/index.html`). A listing only: no file is opened. A
 * project with no such folder, or one that cannot be read, has none.
 */
export async function readDesignsFolder(
  listDir: (path: string) => Promise<Array<{ name: string; path: string; dir: boolean }>>,
  projectPath: string,
): Promise<Array<{ name: string; path: string }>> {
  const list = async (path: string) => {
    try {
      const entries = await listDir(path);
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  };
  const top = await list(`${projectPath.replace(/[\\/]+$/, '')}/${DESIGNS_FOLDER}`);
  const nested = await Promise.all(top.filter((e) => e.dir).slice(0, FOLDER_LIMIT.subfolders).map((e) => list(e.path)));
  return [...top, ...nested.flat()].filter((e) => !e.dir).slice(0, FOLDER_LIMIT.files);
}

/** Folder designs join the chat index; a path a chat already produced keeps its chat. */
export function withFolderDesigns(entries: readonly ArtifactEntry[], folder: readonly ArtifactEntry[]): ArtifactEntry[] {
  const seen = new Set(entries.map((e) => e.path.toLowerCase()));
  return [...entries, ...folder.filter((e) => !seen.has(e.path.toLowerCase()) && seen.add(e.path.toLowerCase()))];
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

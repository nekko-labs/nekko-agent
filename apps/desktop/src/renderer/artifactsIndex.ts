import type { Session, SessionSummary } from '@nekko-agent/shared';
import { chatArtifacts } from './chatArtifacts.js';
import { mainCheckoutPath, normalizePath, toolArg, toolPaths, WRITE_TOOLS } from './artifactPaths.js';

export { mainCheckoutPath } from './artifactPaths.js';

/**
 * Everything agents have produced, across chats, for Library: the documents a
 * reply links to (the same cards a reply shows) and the files the agent itself
 * wrote (`write_file`, or Claude Code's `Write`), grouped by what kind of thing
 * they are. The designs in each project's `nekko-designs/` folder join them,
 * whoever put them there.
 *
 * Worked out in the renderer from transcripts and a folder listing, so nothing
 * new is stored and the host keeps one source of truth: the chat. A path a
 * chat named but that is not on disk (deleted since, or never written) is
 * dropped once its folder has been listed: see `presentPaths`.
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
/** Files that are part of an app being built, or an agent's own notes (`.claude/`), not an output: skip them even when an agent writes one. */
const NOT_AN_OUTPUT = /(?:^|\/)(?:node_modules|\.git|dist|build|out|target|src|app|apps|packages|lib|public|test|tests|\.shots|\.github|\.claude)\//i;
const NOT_AN_OUTPUT_NAME = /^(?:package(?:-lock)?\.json|tsconfig.*\.json|readme\.md|changelog\.md|agents\.md|claude\.md|spec\.md|tasks\.md|license(?:\.md)?|\.?.*rc\.json)$/i;

/** Whether a file sits where designs go, or its own name says it is one, whatever its kind. */
export function inDesignPlace(path: string): boolean {
  const p = path.replaceAll('\\', '/');
  const name = p.split('/').pop() ?? '';
  return DESIGN_DIR.test(p) || DESIGN_NAME.test(name.replace(/\.[^.]+$/, ''));
}

/**
 * What kind of file Library lists it as. A page in a designs place is a Design;
 * a picture is always an Image, even a design's screenshot or mockup (#3145).
 */
export function artifactKind(path: string): ArtifactKind | null {
  const p = path.replaceAll('\\', '/');
  const ext = p.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  const kind = KIND_BY_EXT[ext];
  if (!kind) return null;
  if (kind === 'web' && inDesignPlace(p)) return 'design';
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
  /**
   * Linked from a reply, written by the agent and never linked, found in a project's designs folder,
   * or another computer's file through Nekko Cloud (a read-only copy, #2748).
   */
  source: 'linked' | 'written' | 'folder' | 'cloud';
  /** For a `cloud` file: the computer it came from. */
  device?: string;
  /** A design saved more than once: every version, oldest first. The entry itself is the newest. */
  versions?: DesignVersion[];
}

/** One saved version of a design: `checkout-design-v2.html` is version 2 of `checkout-design.html`. */
export interface DesignVersion {
  version: number;
  path: string;
}

const normalize = normalizePath;

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
export function sessionArtifacts(
  session: Pick<Session, 'id' | 'title' | 'messages'>,
  basePath?: string,
  /** The chat a helper agent's files belong to: its parent, which Library opens. */
  owner: { id: string; title: string } = session,
): ArtifactEntry[] {
  const out = new Map<string, ArtifactEntry>();
  const put = (e: ArtifactEntry) => {
    const key = e.path.toLowerCase();
    const prev = out.get(key);
    if (!prev) { out.set(key, e); return; }
    out.set(key, { ...prev, at: Math.max(prev.at, e.at), ...(e.source === 'linked' ? { title: e.title, source: 'linked' as const } : {}) });
  };
  const known = toolPaths(session.messages);
  for (const m of session.messages) {
    if (m.role !== 'assistant') continue;
    for (const a of chatArtifacts(m.content, basePath, known)) {
      // A localhost preview server is not a file the chat produced.
      if (a.live) continue;
      const kind = artifactKind(a.path);
      if (kind) put({ path: a.path, title: a.title, filename: a.filename, kind, sessionId: owner.id, sessionTitle: owner.title, at: m.createdAt, source: 'linked' });
    }
    for (const call of m.toolCalls ?? []) {
      const arg = toolArg(call.name);
      const named = arg ? call.input?.[arg] : undefined;
      if (typeof named !== 'string') continue;
      const raw = named.trim();
      if (!raw) continue;
      const absolute = /^(?:[a-z]:[\\/]|\/)/i.test(raw);
      if (!absolute && !basePath) continue;
      const path = normalize(absolute ? raw : `${basePath}/${raw}`);
      const kind = artifactKind(path);
      // Reading, editing or searching a file makes it this chat's only when it is a design, or a design's picture.
      if (!kind || (!Object.hasOwn(WRITE_TOOLS, call.name) && kind !== 'design' && !(kind === 'image' && inDesignPlace(path)))) continue;
      const filename = path.split('/').pop() ?? path;
      // A worktree's own folder (`.claude/worktrees/x/`) is not a sign of an app's source: judge the path inside it.
      const inRepo = mainCheckoutPath(path) ?? path;
      const rel = basePath && inRepo.toLowerCase().startsWith(normalize(basePath).toLowerCase()) ? inRepo.slice(normalize(basePath).length) : inRepo;
      if (NOT_AN_OUTPUT.test(rel) || NOT_AN_OUTPUT_NAME.test(filename)) continue;
      put({ path, title: titleFor(path), filename, kind, sessionId: owner.id, sessionTitle: owner.title, at: m.createdAt, source: 'written' });
    }
  }
  return [...out.values()];
}

/**
 * The designs sitting in a project's designs folder, from a listing of it (and
 * of its subfolders): its pages, as Designs, and its pictures, as Images. No
 * chat is attached, so they carry the project's name instead.
 */
export function folderDesigns(project: string, files: ReadonlyArray<{ path: string; name: string }>): ArtifactEntry[] {
  const out: ArtifactEntry[] = [];
  for (const f of files) {
    const path = normalize(f.path);
    const kind = artifactKind(path);
    if (kind !== 'design' && kind !== 'image') continue;
    out.push({ path, title: titleFor(path), filename: f.name, kind, sessionId: '', sessionTitle: project, at: 0, source: 'folder' });
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

/** How many folders inside a project are checked for a designs folder of their own. */
const NESTED_PROJECTS = 80;
const NOT_A_PROJECT = /^(?:\.|node_modules$|dist$|build$|out$|target$)/i;

/**
 * The designs folders of a project and of the projects one level inside it: a
 * chat folder is often a parent of many repos (`code/` holding `code/floop/`),
 * and each repo keeps its own `nekko-designs/`. Listings only, bounded.
 */
export async function readProjectDesignFolders(
  listDir: (path: string) => Promise<Array<{ name: string; path: string; dir: boolean }>>,
  project: { name: string; path: string },
): Promise<Array<{ project: string; files: Array<{ name: string; path: string }> }>> {
  let inside: Array<{ name: string; path: string; dir: boolean }> = [];
  try {
    const listed = await listDir(project.path.replace(/[\\/]+$/, ''));
    if (Array.isArray(listed)) inside = listed.filter((e) => e.dir && !NOT_A_PROJECT.test(e.name) && e.name.toLowerCase() !== DESIGNS_FOLDER).slice(0, NESTED_PROJECTS);
  } catch { /* Unreadable: only the project's own folder is tried. */ }
  const own = { project: project.name, files: await readDesignsFolder(listDir, project.path) };
  const nested = await Promise.all(inside.map(async (d) => ({ project: d.name, files: await readDesignsFolder(listDir, d.path) })));
  return [own, ...nested].filter((f) => f.files.length > 0);
}

/** Folders listed at once when checking which files are still there. */
const PRESENCE_BATCH = 8;

/**
 * The paths (lower-cased) that are still on disk, or cannot be checked: each
 * file's folder is listed once (names only, nothing opened), and a file whose
 * folder lists without it is gone. A folder that cannot be listed counts its
 * files as present, so a slow or refused read never hides anything.
 */
export async function presentPaths(
  listDir: (path: string) => Promise<Array<{ name: string }>>,
  paths: readonly string[],
): Promise<Set<string>> {
  const byFolder = new Map<string, string[]>();
  for (const p of paths) {
    const slash = p.replaceAll('\\', '/').lastIndexOf('/');
    if (slash <= 0) continue;
    const folder = p.slice(0, slash);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), p]);
  }
  const present = new Set(paths.filter((p) => p.replaceAll('\\', '/').lastIndexOf('/') <= 0).map((p) => p.toLowerCase()));
  const folders = [...byFolder];
  for (let i = 0; i < folders.length; i += PRESENCE_BATCH) {
    await Promise.all(folders.slice(i, i + PRESENCE_BATCH).map(async ([folder, files]) => {
      let names: Set<string> | null = null;
      try {
        const listed = await listDir(folder);
        if (Array.isArray(listed)) names = new Set(listed.map((e) => String(e?.name ?? '').toLowerCase()));
      } catch { /* Unknown, so kept. */ }
      for (const f of files) {
        const name = f.slice(f.replaceAll('\\', '/').lastIndexOf('/') + 1).toLowerCase();
        if (!names || names.has(name)) present.add(f.toLowerCase());
      }
    }));
  }
  return present;
}

/**
 * Where a file that is gone from its git worktree lives now: the same place in
 * the repo's main checkout, once its branch merged and the worktree was
 * removed. Keyed by the old path, lower-cased; only files the main checkout
 * lists and the worktree no longer does (a worktree folder that is gone or
 * cannot be listed counts as gone). Paths outside a worktree are skipped.
 */
export async function movedPaths(
  listDir: (path: string) => Promise<Array<{ name: string }>>,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const moves = paths.flatMap((p) => { const to = mainCheckoutPath(p); return to ? [[normalize(p), to] as const] : []; });
  const folderOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
  // Each folder listed once; one that cannot be listed lists nothing.
  const names = new Map<string, Set<string>>();
  const folders = [...new Set(moves.flatMap(([from, to]) => [folderOf(from), folderOf(to)]))];
  for (let i = 0; i < folders.length; i += PRESENCE_BATCH) {
    await Promise.all(folders.slice(i, i + PRESENCE_BATCH).map(async (folder) => {
      try {
        const listed = await listDir(folder);
        if (Array.isArray(listed)) names.set(folder.toLowerCase(), new Set(listed.map((e) => String(e?.name ?? '').toLowerCase())));
      } catch { /* Not there. */ }
    }));
  }
  const lists = (p: string) => !!names.get(folderOf(p).toLowerCase())?.has(p.slice(p.lastIndexOf('/') + 1).toLowerCase());
  const out = new Map<string, string>();
  for (const [from, to] of moves) if (!lists(from) && lists(to)) out.set(from.toLowerCase(), to);
  return out;
}

/**
 * Point moved files at where they live now, keeping one entry per path: a
 * chat's entry wins over the same file found in a designs folder.
 */
export function relocate(entries: readonly ArtifactEntry[], moved: ReadonlyMap<string, string>): ArtifactEntry[] {
  if (!moved.size) return [...entries];
  const out = new Map<string, ArtifactEntry>();
  for (const e of entries) {
    const to = moved.get(e.path.toLowerCase());
    const next = to ? { ...e, path: to, filename: to.split('/').pop() ?? e.filename } : e;
    const key = next.path.toLowerCase();
    const prev = out.get(key);
    if (!prev || (prev.source === 'folder' && next.source !== 'folder') || (prev.source !== 'folder' && next.source !== 'folder' && next.at > prev.at)) out.set(key, next);
  }
  return [...out.values()];
}

/** Folder designs join the chat index; a path a chat already produced keeps its chat. */
export function withFolderDesigns(entries: readonly ArtifactEntry[], folder: readonly ArtifactEntry[]): ArtifactEntry[] {
  const seen = new Set(entries.map((e) => e.path.toLowerCase()));
  return [...entries, ...folder.filter((e) => !seen.has(e.path.toLowerCase()) && seen.add(e.path.toLowerCase()))];
}

/** `-v2`, `_v3`, `.v4` or ` v5` at the end of a file's name, before its extension. */
const VERSION_SUFFIX = /^(.+?)[-_. ]v(\d{1,3})$/i;

/**
 * Which design a file is a version of, and which version: the file without a
 * number is version 1, `name-v2.html` is version 2 of `name.html`.
 */
export function designVersion(path: string): { design: string; version: number } {
  const slash = path.lastIndexOf('/');
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  const numbered = VERSION_SUFFIX.exec(stem);
  if (!numbered) return { design: path.toLowerCase(), version: 1 };
  return { design: `${path.slice(0, slash + 1)}${numbered[1]}${ext}`.toLowerCase(), version: Number(numbered[2]) };
}

/**
 * The numbered files of one design as one entry: the newest version stands for
 * the design (its path, its chat), named without the number, and carries every
 * version. Everything that is not a design, and a design saved once, is left
 * as it is.
 */
export function groupDesignVersions(entries: readonly ArtifactEntry[]): ArtifactEntry[] {
  const byDesign = new Map<string, ArtifactEntry[]>();
  for (const e of entries) {
    if (e.kind !== 'design') continue;
    const key = designVersion(e.path).design;
    byDesign.set(key, [...(byDesign.get(key) ?? []), e]);
  }
  const out: ArtifactEntry[] = [];
  const done = new Set<string>();
  for (const e of entries) {
    const key = e.kind === 'design' ? designVersion(e.path).design : '';
    const group = key ? byDesign.get(key)! : [e];
    if (group.length === 1) { out.push(e); continue; }
    if (done.has(key)) continue;
    done.add(key);
    const versions = group.map((g) => ({ version: designVersion(g.path).version, path: g.path })).sort((a, b) => a.version - b.version);
    const newest = group.find((g) => g.path === versions.at(-1)!.path)!;
    out.push({ ...newest, title: newest.title.replace(/[-_. ]v\d{1,3}$/i, ''), at: Math.max(...group.map((g) => g.at)), versions });
  }
  return out;
}

/** Chats worth scanning: top-level, real conversations, newest first. */
export function artifactCandidates(sessions: readonly SessionSummary[], limit = 60): SessionSummary[] {
  return sessions
    .filter((s) => !s.parentSessionId && !s.incognito && s.chatType !== 'image' && s.exchangeCount > 1)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/**
 * The helper agents those chats started (a design agent the chat handed a
 * design to, say): what they wrote is the chat's, so Library lists it under
 * the chat. Most run one long turn, so no exchange count is asked of them.
 */
export function helperCandidates(sessions: readonly SessionSummary[], parents: readonly SessionSummary[]): Array<SessionSummary & { parent: SessionSummary }> {
  const byId = new Map(parents.map((p) => [p.id, p]));
  const out: Array<SessionSummary & { parent: SessionSummary }> = [];
  for (const s of sessions) {
    const parent = s.parentSessionId ? byId.get(s.parentSessionId) : undefined;
    if (parent && !s.incognito) out.push({ ...s, parent });
  }
  return out;
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

/**
 * The Library entry a chat's "Open in Library" means: the listed entry that is
 * this file, or that has it as one of its versions (then `version` names it),
 * else an entry made from the path alone (`listed` false), so a file Library
 * has not read yet still opens at once.
 */
export function libraryEntryFor(
  entries: readonly ArtifactEntry[] | null,
  path: string,
  origin?: { id: string; title: string },
): { entry: ArtifactEntry; version: string | null; listed: boolean } {
  const p = normalize(path);
  const want = p.toLowerCase();
  for (const e of entries ?? []) {
    if (e.path.toLowerCase() === want) return { entry: e, version: null, listed: true };
    const v = e.versions?.find((x) => x.path.toLowerCase() === want);
    if (v) return { entry: e, version: v.path, listed: true };
  }
  const filename = p.split('/').pop() ?? p;
  return {
    entry: { path: p, title: titleFor(p), filename, kind: artifactKind(p) ?? 'doc', sessionId: origin?.id ?? '', sessionTitle: origin?.title ?? '', at: 0, source: 'linked' },
    version: null,
    listed: false,
  };
}

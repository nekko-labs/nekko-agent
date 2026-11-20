import type { LibraryFileSync, LibraryRemoteFile, LibrarySyncFile, LibrarySyncStatus } from '@nekko-agent/shared';
import type { StatusTone } from '../../tokens.js';
import { ARTIFACT_KINDS, artifactKind, type ArtifactEntry, type ArtifactKind } from '../../artifactsIndex.js';

/**
 * Library on Nekko Cloud (#2748), the app's half: which files the engine is
 * told about, how other computers' files join Library, and what each file's
 * cloud and the header say. The engine (crates/nekko-cloud) reads, seals and
 * uploads the files; nothing here reads a file.
 */

/** A file's state on its tile: the engine's, or `remote` for another computer's file. */
export type TileSync = LibraryFileSync | 'remote';

/** The files to tell the engine about: every file Library lists here, each version of a design included. */
export function syncFilesOf(entries: readonly ArtifactEntry[]): LibrarySyncFile[] {
  const out: LibrarySyncFile[] = [];
  for (const e of entries) {
    if (e.source === 'cloud') continue;
    const chat = e.sessionId ? e.sessionTitle : e.sessionTitle ? `${e.sessionTitle} designs folder` : '';
    const paths = e.versions?.length ? e.versions.map((v) => v.path) : [e.path];
    for (const path of paths) out.push({ path, title: e.title, kind: e.kind, chat });
  }
  return out;
}

/** Changes only when what the engine would be told changes. */
export const syncKey = (files: readonly LibrarySyncFile[]) => files.map((f) => `${f.path}\t${f.title}\t${f.kind}\t${f.chat}`).join('\n');

const KINDS = new Set<string>(ARTIFACT_KINDS.map((k) => k.id));
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Other computers' files as Library entries: the copy's path, the computer's name where the chat would be. */
export function remoteEntries(remote: readonly LibraryRemoteFile[]): ArtifactEntry[] {
  return remote.map((r) => {
    const filename = baseName(r.path);
    const kind = (KINDS.has(r.kind) ? r.kind : artifactKind(r.path) ?? 'doc') as ArtifactKind;
    return {
      path: r.path.replaceAll('\\', '/'),
      title: r.title || filename,
      filename,
      kind,
      sessionId: '',
      sessionTitle: r.chat,
      at: r.modifiedAt,
      source: 'cloud' as const,
      device: r.device || 'another computer',
    };
  });
}

/** The computer a file belongs to: another computer's name, or null for this one (#3144). */
export function fileComputer(e: ArtifactEntry): string | null {
  return e.source === 'cloud' ? e.device?.trim() || 'Another computer' : null;
}

/** One computer's files, when Library groups by computer. */
export interface ComputerGroup {
  /** `computer:here`, or `computer:<name>`. */
  id: string;
  label: string;
  items: ArtifactEntry[];
}

/**
 * Files by the computer they belong to (#3144): this computer first, then the others in the
 * order their files first come, each keeping the files' own order (kind by kind, newest first).
 */
export function groupByComputer(entries: readonly ArtifactEntry[], here: string): ComputerGroup[] {
  const groups = new Map<string, ComputerGroup>();
  const local: ComputerGroup = { id: 'computer:here', label: here, items: [] };
  for (const e of entries) {
    const name = fileComputer(e);
    if (name === null) { local.items.push(e); continue; }
    const id = `computer:${name.toLocaleLowerCase()}`;
    const g = groups.get(id) ?? { id, label: name, items: [] };
    g.items.push(e);
    groups.set(id, g);
  }
  return [...(local.items.length ? [local] : []), ...groups.values()];
}

/** Busiest first: one file of a design syncing makes the design's cloud say so. */
const ORDER: readonly TileSync[] = ['syncing', 'pending', 'noRoom', 'unreadable', 'tooLarge', 'off', 'synced', 'remote'];

/** One entry's cloud: null when Library sync isn't open to this account. A design stands for all its versions. */
export function fileSync(library: LibrarySyncStatus | null | undefined, e: ArtifactEntry): TileSync | null {
  if (!library) return null;
  if (e.source === 'cloud') return 'remote';
  if (!library.on) return 'off';
  const paths = e.versions?.length ? e.versions.map((v) => v.path) : [e.path];
  // Not reported back yet: it is on its way.
  const states: TileSync[] = paths.map((p) => library.files[p] ?? 'pending');
  return ORDER.find((s) => states.includes(s)) ?? 'synced';
}

/** What a file's cloud says, for its tooltip and screen readers. */
export function syncLabel(state: TileSync, device?: string): string {
  switch (state) {
    case 'synced': return 'Backed up to Nekko Cloud';
    case 'syncing': return 'Uploading to Nekko Cloud';
    case 'pending': return 'Waiting to back up to Nekko Cloud';
    case 'off': return 'Not backed up: sync is off on this computer';
    case 'tooLarge': return 'Not backed up: larger than 8 MB';
    case 'unreadable': return 'Not backed up: the file could not be read';
    case 'noRoom': return 'Not backed up: your Nekko Cloud storage is full';
    case 'remote': return `From ${device ?? 'another computer'}, through Nekko Cloud. Read-only here`;
  }
}

/** The header's dot and word for Library's sync as a whole, or null when there is nothing to say. */
export function syncSummary(library: LibrarySyncStatus | null | undefined, entries: readonly ArtifactEntry[]): { tone: StatusTone; word: string; detail: string } | null {
  if (!library) return null;
  const local = entries.filter((e) => e.source !== 'cloud');
  if (!library.on) return { tone: 'neutral', word: 'Not backed up', detail: 'Turn on sync in Settings, Nekko Cloud, to back up Library files and see them on your other computers.' };
  if (!local.length) return null;
  const count = (s: TileSync) => local.filter((e) => fileSync(library, e) === s).length;
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  const skipped = count('tooLarge') + count('unreadable');
  const also = skipped ? ` ${files(skipped)} can't be backed up (larger than 8 MB or unreadable).` : '';
  const syncing = count('syncing');
  if (syncing) return { tone: 'neutral', word: `Backing up ${files(syncing)}`, detail: `Uploading to Nekko Cloud, end-to-end encrypted.${also}` };
  const full = count('noRoom');
  if (full) return { tone: 'warning', word: 'Nekko Cloud storage full', detail: `${files(full)} wait for room on your plan.${also}` };
  const pending = count('pending');
  if (pending) return { tone: 'neutral', word: `${files(pending)} waiting to back up`, detail: `They upload with the next sync, within a minute.${also}` };
  if (skipped) return { tone: 'warning', word: `${files(skipped)} not backed up`, detail: `Larger than 8 MB or unreadable. Everything else is backed up.` };
  return { tone: 'success', word: 'Backed up', detail: 'Every Library file here is backed up to Nekko Cloud, end-to-end encrypted, and shows on your other computers.' };
}

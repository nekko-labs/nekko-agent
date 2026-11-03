import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Where published artifacts live. Keys are `/`-separated and already checked
 * by the caller (`files.ts`): no `..`, no leading `/`, no backslashes. The
 * server needs nothing more than put, get, list by prefix and delete by
 * prefix, so the same interface fits a local folder and any S3-compatible
 * store (R2, Tigris, Supabase Storage, MinIO), whichever hosts Nekko Cloud.
 */
export interface Storage {
  put(key: string, body: Uint8Array): Promise<void>;
  /** The object's bytes, or `null` when there is none. */
  get(key: string): Promise<Uint8Array | null>;
  /** Removes one object; nothing happens when there is none. */
  delete(key: string): Promise<void>;
  /** Every key under `prefix` (which ends in `/`), in no particular order. */
  list(prefix: string): Promise<string[]>;
  /** Removes every key under `prefix` (which ends in `/`). */
  deletePrefix(prefix: string): Promise<void>;
}

/** A folder on this machine: the self-host default. */
export class DiskStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * The file for `key`. The server only passes checked keys, but this folder
   * is the one place a bad key could reach the disk, so it checks again: the
   * resolved path must stay inside the root.
   */
  private path(key: string): string {
    const path = resolve(this.root, ...key.split('/'));
    if (path !== this.root && !path.startsWith(this.root + sep)) throw new Error(`Storage key outside the data folder: ${key}`);
    return path;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // Written beside it and renamed, so a reader never sees half a file.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.path(prefix);
    try {
      const entries = await readdir(base, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && !e.name.endsWith('.tmp'))
        .map((e) => prefix + join(e.parentPath, e.name).slice(base.length).split(sep).filter(Boolean).join('/'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.path(prefix), { recursive: true, force: true });
  }
}

/** In memory, for tests. */
export class MemoryStorage implements Storage {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) this.objects.delete(k);
  }
}

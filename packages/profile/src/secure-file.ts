import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, JSON.stringify(value, null, 2));
}

/**
 * Fsync a directory so the rename inside it is durable. Directory fsync isn't
 * supported everywhere (Windows in particular), so failures are ignored.
 */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* Best-effort: some platforms can't open or fsync a directory. */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function writeTextAtomic(path: string, content: string): void {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    // Write through an fd so the bytes are fsynced to disk before the rename;
    // without the flush a crash could surface a zero-byte config. These files
    // are other tools' configs, so durability matters.
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeFileSync(fd, content, { encoding: 'utf8' });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (err) {
    // Never leave a stray temp file behind when the write or rename failed.
    try {
      unlinkSync(temp);
    } catch {
      /* The temp file may not exist yet or be locked; harmless either way. */
    }
    throw err;
  }
  fsyncDir(dir);
  chmodSync(path, 0o600);
}

/** Copy `path` to `<path>.bak` before an in-place merge; no-op if absent. */
export function backupFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const backup = `${path}.bak`;
  copyFileSync(path, backup);
  ensurePrivateFile(backup);
  return backup;
}

export function ensurePrivateFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Permissions are best-effort on Windows and unusual filesystems. */
  }
}

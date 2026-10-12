import { createHash } from 'crypto';
import { mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { inflateRawSync } from 'zlib';

/**
 * DirectML.dll, fetched only when a decision model runs on a Windows whose own
 * copy is too old.
 *
 * The app used to ship the 18 MB DLL to everyone for a feature few people
 * use, and Windows 11 already carries a new enough one. nekkod delay-loads it
 * and picks a copy itself (crates/nekko-decide/src/directml.rs); this is the
 * fallback for the machines that have none: Microsoft's own build, from its
 * NuGet package. That package is 200 MB of every architecture plus Xbox, so
 * the one entry is read out of it with HTTP range requests (the zip index,
 * then that file's bytes, about 9 MB) and checked against a pinned hash.
 */

export const DIRECTML = {
  /** What ONNX Runtime 1.28's prebuilt binaries ship and its provider is built against. */
  version: '1.15.4',
  url: 'https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg',
  entries: {
    x64: { name: 'bin/x64-win/DirectML.dll', bytes: 18_527_776, sha256: '9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1' },
    arm64: { name: 'bin/arm64-win/DirectML.dll', bytes: 18_444_832, sha256: '77b0db83ff903f2323f5caf538499d75af6038bbea23b7959f7d232d9a4ab9d4' },
  } as Record<string, { name: string; bytes: number; sha256: string }>,
};

/** Where a downloaded copy lives under `dir`. */
export const directmlPath = (dir: string) => join(dir, DIRECTML.version, 'DirectML.dll');

/** The downloaded copy when it is there and whole, else undefined. */
export async function downloadedDirectml(dir: string, arch: string = process.arch): Promise<string | undefined> {
  const entry = DIRECTML.entries[arch];
  const path = directmlPath(dir);
  const size = await stat(path).then((s) => s.size, () => -1);
  return entry && size === entry.bytes ? path : undefined;
}

/**
 * Fetch DirectML.dll into `dir` and return its path. Throws with a sentence a
 * person can read when the architecture has no build, the network fails, or
 * the bytes are not the pinned ones.
 */
export async function downloadDirectml(
  dir: string,
  opts: { arch?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const arch = opts.arch ?? process.arch;
  const entry = DIRECTML.entries[arch];
  if (!entry) throw new Error(`DirectML has no ${arch} build.`);
  const existing = await downloadedDirectml(dir, arch);
  if (existing) return existing;
  const data = await fetchZipEntry(DIRECTML.url, entry.name, opts.fetch ?? fetch, opts.signal);
  const digest = createHash('sha256').update(data).digest('hex');
  if (data.length !== entry.bytes || digest !== entry.sha256) {
    throw new Error(`The downloaded DirectML.dll is not Microsoft's ${DIRECTML.version} build (checksum mismatch).`);
  }
  const dest = directmlPath(dir);
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  await writeFile(part, data);
  await rm(dest, { force: true });
  await rename(part, dest);
  return dest;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end-of-central-directory record is the last 22 bytes plus a comment of up to 64 KB. */
const TAIL = 22 + 0xffff;

/**
 * One file out of a remote zip, by name, reading only the index and that
 * file's bytes. Stored and deflated entries; no zip64, which a package this
 * size never needs.
 */
export async function fetchZipEntry(url: string, name: string, doFetch: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  const range = async (start: number, end: number): Promise<Buffer> => {
    const res = await doFetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow', signal });
    if (res.status !== 206) throw new Error(`The DirectML package server did not answer a ranged request (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== end - start + 1) throw new Error('The DirectML package server sent a short range.');
    return buf;
  };
  const head = await doFetch(url, { method: 'HEAD', redirect: 'follow', signal });
  const size = Number(head.headers.get('content-length'));
  if (!head.ok || !Number.isFinite(size) || size < 22) throw new Error(`Couldn't reach the DirectML package (HTTP ${head.status}).`);

  const tailStart = Math.max(0, size - TAIL);
  const tail = await range(tailStart, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The DirectML package is not a zip.');
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdOffset + cdSize > size) throw new Error('The DirectML package has an index this reader does not handle.');

  const cd = await range(cdOffset, cdOffset + cdSize - 1);
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === CENTRAL;) {
    const method = cd.readUInt16LE(p + 10);
    const compressed = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const local = cd.readUInt32LE(p + 42);
    if (cd.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      // The local header repeats the name and carries its own extra field,
      // which can differ in length from the central copy.
      const header = await range(local, local + 29);
      if (header.readUInt32LE(0) !== LOCAL) throw new Error('The DirectML package has a damaged entry.');
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const raw = compressed ? await range(start, start + compressed - 1) : Buffer.alloc(0);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`The DirectML package uses a compression method (${method}) this reader does not handle.`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`The DirectML package has no ${name}.`);
}

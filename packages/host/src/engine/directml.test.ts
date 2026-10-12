import { randomBytes } from 'crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateRawSync } from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { DIRECTML, directmlPath, downloadDirectml, downloadedDirectml, fetchZipEntry } from './directml.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const scratch = async () => { const d = await mkdtemp(join(tmpdir(), 'nekko-dml-')); dirs.push(d); return d; };

/** A zip with the given entries, deflated unless `stored`, and a trailing comment. */
function zip(entries: Array<{ name: string; data: Buffer; stored?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.stored ? e.data : deflateRawSync(e.data);
    const name = Buffer.from(e.name);
    const extra = Buffer.from('xx'); // a local extra field the central one does not have
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.stored ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.stored ? 0 : 8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, body);
    centrals.push(central, name);
    offset += 30 + name.length + extra.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from('a package comment');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}

/** A server for one file that honours HEAD and single byte ranges, and counts bytes sent. */
function serve(file: Buffer, opts: { ranges?: boolean } = {}) {
  const sent = { bytes: 0 };
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(file.length) } });
    const range = (init?.headers as Record<string, string> | undefined)?.Range?.match(/bytes=(\d+)-(\d+)/);
    if (!range || opts.ranges === false) {
      sent.bytes += file.length;
      return new Response(file, { status: 200 });
    }
    const body = file.subarray(Number(range[1]), Number(range[2]) + 1);
    sent.bytes += body.length;
    return new Response(body, { status: 206 });
  }) as typeof fetch;
  return { fetchFn, sent };
}

describe('reading one file out of a remote zip', () => {
  const payload = Buffer.from('MZ'.repeat(40_000));
  const archive = zip([
    // Incompressible and bigger than the 64 KB tail read, like the real package's other builds.
    { name: 'bin/x86-win/DirectML.dll', data: randomBytes(200_000), stored: true },
    { name: 'bin/x64-win/DirectML.dll', data: payload },
    { name: 'readme.txt', data: Buffer.from('plain'), stored: true },
  ]);

  it('extracts a deflated entry and a stored one, fetching far less than the whole archive', async () => {
    const { fetchFn, sent } = serve(archive);
    expect((await fetchZipEntry('u', 'bin/x64-win/DirectML.dll', fetchFn)).equals(payload)).toBe(true);
    expect(sent.bytes).toBeLessThan(archive.length);
    expect((await fetchZipEntry('u', 'readme.txt', fetchFn)).toString()).toBe('plain');
  });

  it('says which file is missing, and refuses a server that ignores ranges', async () => {
    await expect(fetchZipEntry('u', 'bin/arm-win/DirectML.dll', serve(archive).fetchFn)).rejects.toThrow(/no bin\/arm-win/);
    await expect(fetchZipEntry('u', 'readme.txt', serve(archive, { ranges: false }).fetchFn)).rejects.toThrow(/ranged request/);
  });

  it('rejects bytes that are not the pinned build and writes nothing', async () => {
    const dir = await scratch();
    const { fetchFn } = serve(archive);
    await expect(downloadDirectml(dir, { arch: 'x64', fetch: fetchFn })).rejects.toThrow(/checksum/);
    expect(await readdir(dir)).toEqual([]);
    await expect(downloadDirectml(dir, { arch: 'ia32', fetch: fetchFn })).rejects.toThrow(/no ia32 build/);
  });

  it('reuses a complete earlier download without fetching', async () => {
    const dir = await scratch();
    const path = directmlPath(dir);
    await mkdir(join(dir, DIRECTML.version), { recursive: true });
    await writeFile(path, Buffer.alloc(DIRECTML.entries.x64.bytes));
    expect(await downloadedDirectml(dir, 'x64')).toBe(path);
    const fetchFn = (async () => { throw new Error('should not fetch'); }) as typeof fetch;
    expect(await downloadDirectml(dir, { arch: 'x64', fetch: fetchFn })).toBe(path);
    // A truncated file is not a download.
    await writeFile(path, Buffer.alloc(10));
    expect(await downloadedDirectml(dir, 'x64')).toBeUndefined();
  });
});

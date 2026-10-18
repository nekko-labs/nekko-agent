import { describe, expect, it } from 'vitest';
import { checkImageUrl, fetchRemoteImage, isPublicAddress, publicOnlyLookup, sniffImageType, IMAGE_MAX_BYTES, type ImageGet } from './remote-image.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function* stream(...chunks: Uint8Array[]) { for (const c of chunks) yield c; }

/** A fake server: one response per URL. */
function server(routes: Record<string, { status?: number; location?: string; body?: Uint8Array[]; length?: number }>): { get: ImageGet; hits: string[] } {
  const hits: string[] = [];
  return {
    hits,
    get: async (url) => {
      hits.push(url.toString());
      const r = routes[url.toString()];
      if (!r) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      return { status: r.status ?? 200, location: r.location, contentLength: r.length, body: stream(...(r.body ?? [])), close: () => {} };
    },
  };
}

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5', '::ffff:8.8.8.8'])('allows %s', (ip) => expect(isPublicAddress(ip)).toBe(true));
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::3', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:c0a8:101::', '2001:0:4136::', '2001:db8::1', 'not-an-ip',
  ])('refuses %s', (ip) => expect(isPublicAddress(ip)).toBe(false));
});

describe('checkImageUrl', () => {
  it('accepts plain public http(s) photo URLs', () => {
    expect(checkImageUrl('https://example.com/a.jpg').hostname).toBe('example.com');
    expect(checkImageUrl('http://8.8.8.8/a.png').hostname).toBe('8.8.8.8');
  });
  it.each([
    ['file:///etc/passwd', 'url'], ['javascript:alert(1)', 'url'], ['data:image/png;base64,AA', 'url'], ['ftp://x.com/a.png', 'url'],
    ['https://user:pw@example.com/a.png', 'url'], ['https://example.com:8080/a.png', 'blocked'], ['http://localhost/a.png', 'blocked'],
    ['http://printer.local/a.png', 'blocked'], ['http://127.0.0.1/a.png', 'blocked'], ['http://[::1]/a.png', 'blocked'],
    ['http://169.254.169.254/latest/meta-data', 'blocked'], ['http://[::ffff:10.0.0.1]/a.png', 'blocked'], ['not a url', 'url'],
  ])('refuses %s', (url, code) => {
    expect(() => checkImageUrl(url)).toThrow(expect.objectContaining({ code }));
  });
});

describe('publicOnlyLookup', () => {
  const run = (answers: Array<{ address: string; family: number }>) => new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
    const resolveDns = ((_h: string, _o: object, cb: (e: Error | null, a: unknown) => void) => cb(null, answers)) as never;
    publicOnlyLookup(resolveDns)('example.com', {}, (err, address) => resolve({ err, address }));
  });
  it('passes a public answer through', async () => {
    expect(await run([{ address: '93.184.216.34', family: 4 }])).toEqual({ err: null, address: '93.184.216.34' });
  });
  it('refuses a name that resolves to a private address (DNS rebinding)', async () => {
    expect((await run([{ address: '127.0.0.1', family: 4 }])).err?.code).toBe('EBLOCKED');
  });
  it('refuses when any one of several answers is private', async () => {
    expect((await run([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }])).err?.code).toBe('EBLOCKED');
  });
});

describe('sniffImageType', () => {
  it('recognises raster formats by their bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('GIF89a....'))).toBe('image/gif');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('\0\0\0\x1cftypavif'))).toBe('image/avif');
  });
  it('refuses SVG, HTML and anything else', () => {
    expect(sniffImageType(new TextEncoder().encode('<svg onload="alert(1)"/>'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('<!doctype html>'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('fetchRemoteImage', () => {
  it('returns an inert data URL typed by the bytes, not the server', async () => {
    const { get } = server({ 'https://cdn.example.com/a.jpg': { body: [JPEG.slice(0, 2), JPEG.slice(2)] } });
    const img = await fetchRemoteImage('https://cdn.example.com/a.jpg', { get });
    expect(img.mime).toBe('image/jpeg');
    expect(img.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}`);
    expect(img.bytes).toBe(JPEG.length);
  });

  it('follows a public redirect and reports where the image came from', async () => {
    const { get, hits } = server({
      'https://example.com/photo': { status: 302, location: '/real.png' },
      'https://example.com/real.png': { body: [PNG] },
    });
    const img = await fetchRemoteImage('https://example.com/photo', { get });
    expect(hits).toEqual(['https://example.com/photo', 'https://example.com/real.png']);
    expect(img.finalUrl).toBe('https://example.com/real.png');
  });

  it('refuses a redirect into the local network or down to http', async () => {
    const { get } = server({
      'https://example.com/a': { status: 301, location: 'http://169.254.169.254/latest/meta-data' },
      'https://example.com/b': { status: 301, location: 'http://example.com/b.png' },
    });
    await expect(fetchRemoteImage('https://example.com/a', { get })).rejects.toMatchObject({ code: 'blocked' });
    await expect(fetchRemoteImage('https://example.com/b', { get })).rejects.toMatchObject({ code: 'blocked' });
  });

  it('stops after too many redirects', async () => {
    const routes: Record<string, { status: number; location: string }> = {};
    for (let i = 0; i < 10; i += 1) routes[`https://example.com/${i}`] = { status: 302, location: `/${i + 1}` };
    await expect(fetchRemoteImage('https://example.com/0', { get: server(routes).get })).rejects.toMatchObject({ code: 'network' });
  });

  it('refuses bodies that are not images, whatever they claim', async () => {
    const { get } = server({ 'https://example.com/a.png': { body: [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')] } });
    await expect(fetchRemoteImage('https://example.com/a.png', { get })).rejects.toMatchObject({ code: 'not-image' });
  });

  it('caps the size by header and by bytes read', async () => {
    const big = server({ 'https://example.com/a.png': { length: IMAGE_MAX_BYTES + 1, body: [PNG] } });
    await expect(fetchRemoteImage('https://example.com/a.png', { get: big.get })).rejects.toMatchObject({ code: 'too-large' });
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(PNG);
    const lying = server({ 'https://example.com/b.png': { body: Array.from({ length: 11 }, () => chunk) } });
    await expect(fetchRemoteImage('https://example.com/b.png', { get: lying.get })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('reports non-200 answers and blocked lookups plainly', async () => {
    const { get } = server({ 'https://example.com/404.png': { status: 404 } });
    await expect(fetchRemoteImage('https://example.com/404.png', { get })).rejects.toMatchObject({ code: 'status' });
    const blocked: ImageGet = async () => { throw Object.assign(new Error('x'), { code: 'EBLOCKED' }); };
    await expect(fetchRemoteImage('https://rebind.example.com/a.png', { get: blocked })).rejects.toMatchObject({ code: 'blocked' });
  });
});

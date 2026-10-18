/**
 * `image:fetch`: a remote photo for the chat, fetched by the host and handed
 * to the renderer as an inert data URL.
 *
 * The renderer never loads a remote URL itself (its CSP is `img-src 'self'
 * data:`), so a picture in a reply cannot beacon, set cookies or reach the
 * user's network on render. Instead the host fetches it under rules a
 * browser would not apply:
 *
 *  - http(s) only, default ports only, no credentials in the URL;
 *  - every address a host name resolves to must be public: loopback, private,
 *    link-local (cloud metadata), CGNAT, multicast and reserved ranges are
 *    refused. The check runs inside the socket's own `lookup`, so the address
 *    that is checked is the address that is dialed (no DNS-rebinding gap);
 *  - redirects are followed by hand, at most five, each hop checked again;
 *  - no cookies, no auth, no referrer; a fixed user agent;
 *  - a size cap and a time limit, and the bytes must *be* a PNG, JPEG, GIF,
 *    WebP or AVIF by their magic number, whatever the server's content type
 *    says. SVG is refused: it is a document, not a photo.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { RemoteImage } from '@nekko-agent/shared';

/** Most bytes read from an image response. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Longest one fetch may take, every redirect included. */
export const IMAGE_TIMEOUT_MS = 20_000;
/** Redirects followed before giving up. */
export const IMAGE_MAX_REDIRECTS = 5;

export type { RemoteImage };

export class RemoteImageError extends Error {
  constructor(public readonly code: 'url' | 'blocked' | 'network' | 'status' | 'too-large' | 'not-image' | 'timeout', message: string) {
    super(message);
    this.name = 'RemoteImageError';
  }
}

/** A URL the fetcher may try at all (before any DNS): http(s), default port, no userinfo. */
export function checkImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new RemoteImageError('url', 'Not a URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RemoteImageError('url', 'Only http and https images can be shown.');
  if (url.username || url.password) throw new RemoteImageError('url', 'Image URLs with credentials are not loaded.');
  // A non-default port is how internal services are usually reached; photos are not served there.
  if (url.port && url.port !== '80' && url.port !== '443') throw new RemoteImageError('blocked', 'Images are only loaded from standard web ports.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new RemoteImageError('blocked', 'Images from this computer or the local network are not loaded.');
  }
  if (isIP(host) && !isPublicAddress(host)) throw new RemoteImageError('blocked', 'Images from this computer or the local network are not loaded.');
  return url;
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function publicIPv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-net, private, loopback, multicast + reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** Expand an IPv6 literal into its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.split('%')[0].toLowerCase();
  // An embedded dotted quad (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = ipv4Parts(dotted[1]);
    if (!p) return null;
    s = s.slice(0, -dotted[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True only for an address on the public internet. Anything unparseable is not. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip.split('%')[0]);
  if (kind === 4) {
    const p = ipv4Parts(ip);
    return !!p && publicIPv4(p);
  }
  if (kind !== 6) return false;
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return publicIPv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return publicIPv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 can tunnel to any IPv4, private ones included
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo, same reason
  return true;
}

/**
 * A `lookup` for http(s).request that resolves as usual and then refuses the
 * connection unless every address is public. Checking *all* of them, not just
 * the first, stops a name that answers with one public and one private address
 * from being dialed on the private one by Happy Eyeballs.
 */
export function publicOnlyLookup(resolve: typeof dnsLookup = dnsLookup): LookupFunction {
  return ((hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = (addresses as unknown as LookupAddress[]) ?? [];
      if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
        const blocked = Object.assign(new Error(`${hostname} resolves to a private or local address.`), { code: 'EBLOCKED' });
        return callback(blocked, '', 0);
      }
      if ((options as { all?: boolean }).all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  }) as LookupFunction;
}

/** The raster type the bytes are, by magic number, or null. */
export function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

/** One GET as a seam for tests: status, headers and a byte stream. */
export type ImageGet = (url: URL, signal: AbortSignal) => Promise<{ status: number; location?: string; contentLength?: number; body: AsyncIterable<Uint8Array>; close: () => void }>;

const HEADERS = {
  accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1',
  'user-agent': 'Mozilla/5.0 (compatible; NekkoAgent/1.0; +https://nekkoagent.com)',
};

/** The real GET: Node's http(s) with the public-only lookup, no agent pooling, no cookies. */
export const nodeImageGet: ImageGet = (url, signal) => new Promise((resolve, reject) => {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = request(url, { method: 'GET', headers: HEADERS, lookup: publicOnlyLookup(), agent: false, signal }, (res: IncomingMessage) => {
    const length = Number(res.headers['content-length']);
    resolve({
      status: res.statusCode ?? 0,
      location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
      contentLength: Number.isFinite(length) ? length : undefined,
      body: res,
      close: () => res.destroy(),
    });
  });
  req.on('error', reject);
  req.end();
});

/** Fetch a remote image under the rules above. */
export async function fetchRemoteImage(rawUrl: string, opts: { get?: ImageGet; signal?: AbortSignal } = {}): Promise<RemoteImage> {
  const get = opts.get ?? nodeImageGet;
  const timeout = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let url = checkImageUrl(rawUrl);
  for (let hop = 0; ; hop += 1) {
    let res: Awaited<ReturnType<ImageGet>>;
    try {
      res = await get(url, signal);
    } catch (e) {
      if (timeout.aborted) throw new RemoteImageError('timeout', 'The image took too long to load.');
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EBLOCKED') throw new RemoteImageError('blocked', 'Images from this computer or the local network are not loaded.');
      throw new RemoteImageError('network', `Could not load the image (${err.code ?? err.message}).`);
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      res.close();
      if (hop >= IMAGE_MAX_REDIRECTS) throw new RemoteImageError('network', 'The image redirected too many times.');
      let next: URL;
      try { next = new URL(res.location, url); } catch { throw new RemoteImageError('url', 'The image redirected to an invalid address.'); }
      // Never step down from https to http on a redirect.
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new RemoteImageError('blocked', 'The image redirected from https to http.');
      url = checkImageUrl(next.toString());
      continue;
    }
    if (res.status !== 200) {
      res.close();
      throw new RemoteImageError('status', `The image server answered HTTP ${res.status}.`);
    }
    if (res.contentLength !== undefined && res.contentLength > IMAGE_MAX_BYTES) {
      res.close();
      throw new RemoteImageError('too-large', `The image is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > IMAGE_MAX_BYTES) {
          res.close();
          throw new RemoteImageError('too-large', `The image is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
        }
        chunks.push(chunk);
      }
    } catch (e) {
      if (e instanceof RemoteImageError) throw e;
      if (timeout.aborted) throw new RemoteImageError('timeout', 'The image took too long to load.');
      throw new RemoteImageError('network', 'The image download was interrupted.');
    }
    const bytes = Buffer.concat(chunks);
    const mime = sniffImageType(bytes);
    if (!mime) throw new RemoteImageError('not-image', 'That address is not a PNG, JPEG, GIF, WebP or AVIF image.');
    return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, mime, bytes: bytes.byteLength, finalUrl: url.toString() };
  }
}

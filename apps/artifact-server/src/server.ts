import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { contentType, DOWNLOAD_TYPE, ID_PATTERN, pathProblem } from './files.js';
import type { Storage } from './storage.js';

/**
 * Nekko Artifacts server. Publishes an artifact (an HTML page with the files
 * it loads, a document, an image, a report) at a stable URL that anyone with
 * the link can open.
 *
 * It is two apps, meant to run on two origins:
 *   - `api`: the owner's upload API, behind a bearer token. Create, republish
 *     under the same id (a new version, the same URL), list, read, delete,
 *     and the usage against this token's limits.
 *   - `content`: serves the latest version of each artifact at
 *     `<publicUrl>/<id>/`, read only and with no cookies.
 *
 * Isolation. A published page is someone's arbitrary HTML and JS, so the
 * content origin must not be the app's or the API's: a page there shares no
 * cookies or storage with them. On top of that every response carries a CSP
 * with `sandbox` (without `allow-same-origin`), so the page runs in an opaque
 * origin: it can't read the content origin's storage, and another artifact's
 * files are cross-origin to it. Its sources are limited to its own folder
 * (`<publicUrl>/<id>/`), so it loads nothing from another artifact or the
 * wider web, and it can't submit a form anywhere (`form-action 'none'`),
 * which also rules out the simplest credential-collection page.
 *
 * The opaque origin makes even the page's own files cross-origin to it, so
 * `content` answers with `Access-Control-Allow-Origin: *`: a dashboard can
 * fetch its own `data.json`. That reveals nothing: there are no cookies or
 * credentials to send, a file is already readable by anyone who has its URL,
 * and the CSP still keeps each page to its own folder.
 *
 * Static only: there is no server-side code, and the API is shaped so stored
 * state can come later without changing the URLs.
 */

export interface Limits {
  /** Artifacts one token may have published at once. */
  maxArtifacts: number;
  /** Total bytes of one version's files. */
  maxArtifactBytes: number;
  /** Files in one version. */
  maxFiles: number;
  /** Versions kept per artifact; older ones are deleted on republish. */
  keepVersions: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxArtifacts: 100,
  maxArtifactBytes: 25 * 1024 * 1024,
  maxFiles: 500,
  keepVersions: 10,
};

/** Who may publish, and how much. The token itself is never kept, only its hash. */
export interface TokenEntry {
  /** Names the owner in the stored metadata; never shown publicly. */
  owner: string;
  sha256: Buffer;
  limits: Limits;
}

export function tokenEntry(owner: string, token: string, limits: Limits = DEFAULT_LIMITS): TokenEntry {
  return { owner, sha256: sha256(token), limits };
}

export interface ArtifactServerOptions {
  storage: Storage;
  tokens: TokenEntry[];
  /** Where `content` is reachable, e.g. `https://nekko.page` or `http://localhost:4501`. */
  publicUrl: string;
  now?: () => number;
  newId?: () => string;
}

type Visibility = 'unlisted' | 'public';

interface StoredFile {
  path: string;
  size: number;
  sha256: string;
  type: string;
}

interface StoredVersion {
  n: number;
  createdAt: number;
  entry: string;
  bytes: number;
  files: StoredFile[];
}

interface StoredArtifact {
  id: string;
  owner: string;
  title: string;
  visibility: Visibility;
  createdAt: number;
  updatedAt: number;
  versions: StoredVersion[];
}

interface Upload {
  title: string;
  visibility: Visibility;
  entry: string;
  files: { path: string; body: Buffer }[];
  bytes: number;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_TITLE = 200;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function buildArtifactServer(opts: ArtifactServerOptions): { api: FastifyInstance; content: FastifyInstance } {
  const { storage, tokens } = opts;
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? randomId;
  const publicUrl = opts.publicUrl.replace(/\/+$/, '');
  // Base64 grows a payload by a third; leave room for the JSON around it.
  const largest = Math.max(DEFAULT_LIMITS.maxArtifactBytes, ...tokens.map((t) => t.limits.maxArtifactBytes));
  const bodyLimit = Math.ceil((largest * 4) / 3) + 1024 * 1024;

  const locks = new Map<string, Promise<unknown>>();
  /** One write at a time per artifact, so two republishes can't both take version n+1. */
  function locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const before = locks.get(id) ?? Promise.resolve();
    const next = before.then(run, run);
    const settled = next.catch(() => undefined);
    locks.set(id, settled);
    void settled.then(() => {
      if (locks.get(id) === settled) locks.delete(id);
    });
    return next;
  }

  const metaKey = (id: string) => `meta/${id}.json`;
  const objectKey = (id: string, n: number, path: string) => `objects/${id}/${n}/${path}`;

  async function load(id: string): Promise<StoredArtifact | null> {
    if (!ID_PATTERN.test(id)) return null;
    const raw = await storage.get(metaKey(id));
    return raw ? (JSON.parse(Buffer.from(raw).toString('utf8')) as StoredArtifact) : null;
  }

  async function save(a: StoredArtifact): Promise<void> {
    await storage.put(metaKey(a.id), Buffer.from(JSON.stringify(a)));
  }

  async function owned(owner: string): Promise<StoredArtifact[]> {
    const keys = await storage.list('meta/');
    const all = await Promise.all(keys.map((k) => load(k.slice('meta/'.length, -'.json'.length))));
    return all.filter((a): a is StoredArtifact => !!a && a.owner === owner);
  }

  function urlOf(a: StoredArtifact): string {
    const entry = latest(a).entry;
    return `${publicUrl}/${a.id}/${entry === 'index.html' ? '' : entry.split('/').map(encodeURIComponent).join('/')}`;
  }

  function view(a: StoredArtifact, withVersions = false) {
    const v = latest(a);
    return {
      id: a.id,
      title: a.title,
      visibility: a.visibility,
      url: urlOf(a),
      version: v.n,
      entry: v.entry,
      bytes: v.bytes,
      files: v.files.length,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      ...(withVersions && {
        versions: a.versions.map((x) => ({ n: x.n, createdAt: x.createdAt, entry: x.entry, bytes: x.bytes, files: x.files.length })),
      }),
    };
  }

  function parseUpload(body: unknown, limits: Limits, before?: StoredArtifact): Upload {
    if (!body || typeof body !== 'object') throw new Refusal(400, 'bad_request', 'The body must be a JSON object.');
    const b = body as Record<string, unknown>;
    const title = b.title === undefined ? (before?.title ?? 'Untitled') : b.title;
    if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE) {
      throw new Refusal(400, 'bad_title', `The title must be 1 to ${MAX_TITLE} characters.`);
    }
    const visibility = b.visibility === undefined ? (before?.visibility ?? 'unlisted') : b.visibility;
    if (visibility !== 'unlisted' && visibility !== 'public') {
      throw new Refusal(400, 'bad_visibility', 'The visibility must be "unlisted" or "public".');
    }
    if (!Array.isArray(b.files) || b.files.length === 0) throw new Refusal(400, 'no_files', 'An artifact needs at least one file.');
    if (b.files.length > limits.maxFiles) {
      throw new Refusal(413, 'too_many_files', `An artifact can have at most ${limits.maxFiles} files; this one has ${b.files.length}.`);
    }
    const seen = new Set<string>();
    const files: Upload['files'] = [];
    let bytes = 0;
    for (const f of b.files as unknown[]) {
      const file = (f ?? {}) as Record<string, unknown>;
      const problem = pathProblem(file.path);
      if (problem) throw new Refusal(400, 'bad_path', `Can't publish: ${problem}.`);
      const path = file.path as string;
      if (seen.has(path)) throw new Refusal(400, 'duplicate_path', `"${path}" is in the upload twice.`);
      seen.add(path);
      if (typeof file.data !== 'string' || file.data.length % 4 !== 0 || !BASE64.test(file.data)) {
        throw new Refusal(400, 'bad_data', `"${path}" must be base64 in "data".`);
      }
      const body = Buffer.from(file.data, 'base64');
      bytes += body.length;
      if (bytes > limits.maxArtifactBytes) {
        throw new Refusal(413, 'too_large', `An artifact can be at most ${formatBytes(limits.maxArtifactBytes)}.`);
      }
      files.push({ path, body });
    }
    const entry = b.entry === undefined ? defaultEntry(files.map((f) => f.path)) : b.entry;
    if (typeof entry !== 'string' || !seen.has(entry)) {
      throw new Refusal(400, 'bad_entry', 'Name the file to open first in "entry"; it must be one of the files.');
    }
    return { title: title.trim(), visibility, entry, files, bytes };
  }

  async function writeVersion(a: StoredArtifact, upload: Upload, n: number): Promise<StoredVersion> {
    const files: StoredFile[] = [];
    for (const f of upload.files) {
      await storage.put(objectKey(a.id, n, f.path), f.body);
      files.push({ path: f.path, size: f.body.length, sha256: sha256(f.body).toString('hex'), type: contentType(f.path) });
    }
    return { n, createdAt: now(), entry: upload.entry, bytes: upload.bytes, files };
  }

  // ---- API -------------------------------------------------------------

  const api = Fastify({ bodyLimit, logger: false });

  api.setErrorHandler((err, _req, reply) => {
    if (err instanceof Refusal) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413) return reply.code(413).send({ error: 'too_large', message: 'The upload is too large.' });
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'bad_request', message: err instanceof Error ? err.message : 'Bad request.' });
    console.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on the artifact server.' });
  });

  api.get('/healthz', async () => ({ ok: true }));

  function who(req: FastifyRequest): TokenEntry {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (match) {
      const hash = sha256(match[1]);
      // Every entry is compared, so the time taken says nothing about which one matched.
      let found: TokenEntry | undefined;
      for (const t of tokens) if (timingSafeEqual(t.sha256, hash)) found = t;
      if (found) return found;
    }
    throw new Refusal(401, 'unauthorized', 'A valid token is needed: send it as "Authorization: Bearer <token>".');
  }

  async function mine(req: FastifyRequest, id: string): Promise<{ token: TokenEntry; artifact: StoredArtifact }> {
    const token = who(req);
    const artifact = await load(id);
    // Someone else's artifact is "not found" too, so ids can't be probed.
    if (!artifact || artifact.owner !== token.owner) throw new Refusal(404, 'not_found', 'No such artifact.');
    return { token, artifact };
  }

  api.get('/v1/usage', async (req) => {
    const token = who(req);
    const list = await owned(token.owner);
    return { artifacts: list.length, bytes: list.reduce((s, a) => s + latest(a).bytes, 0), limits: token.limits };
  });

  api.get('/v1/artifacts', async (req) => {
    const token = who(req);
    const list = await owned(token.owner);
    return { artifacts: list.sort((x, y) => y.updatedAt - x.updatedAt).map((a) => view(a)) };
  });

  api.post('/v1/artifacts', async (req, reply) => {
    const token = who(req);
    const upload = parseUpload(req.body, token.limits);
    const id = newId();
    return locked(`owner:${token.owner}`, async () => {
      const count = (await owned(token.owner)).length;
      if (count >= token.limits.maxArtifacts) {
        throw new Refusal(403, 'limit_reached', `This server allows ${token.limits.maxArtifacts} published artifacts; delete one to publish another.`);
      }
      const at = now();
      const artifact: StoredArtifact = { id, owner: token.owner, title: upload.title, visibility: upload.visibility, createdAt: at, updatedAt: at, versions: [] };
      artifact.versions.push(await writeVersion(artifact, upload, 1));
      await save(artifact);
      return reply.code(201).send(view(artifact, true));
    });
  });

  api.get<{ Params: { id: string } }>('/v1/artifacts/:id', async (req) => view((await mine(req, req.params.id)).artifact, true));

  api.put<{ Params: { id: string } }>('/v1/artifacts/:id', async (req) => {
    const { id } = req.params;
    return locked(id, async () => {
      const { token, artifact } = await mine(req, id);
      const upload = parseUpload(req.body, token.limits, artifact);
      const n = latest(artifact).n + 1;
      const version = await writeVersion(artifact, upload, n);
      artifact.versions.push(version);
      artifact.title = upload.title;
      artifact.visibility = upload.visibility;
      artifact.updatedAt = version.createdAt;
      const dropped = artifact.versions.splice(0, Math.max(0, artifact.versions.length - token.limits.keepVersions));
      // The metadata moves on first, so a crash leaves orphan files, never a link to missing ones.
      await save(artifact);
      for (const old of dropped) await storage.deletePrefix(`objects/${id}/${old.n}/`);
      return view(artifact, true);
    });
  });

  api.delete<{ Params: { id: string } }>('/v1/artifacts/:id', async (req, reply) => {
    const { id } = req.params;
    return locked(id, async () => {
      await mine(req, id);
      // The metadata goes first: from then on the URL is gone, whatever happens to the files.
      await storage.delete(metaKey(id));
      await storage.deletePrefix(`objects/${id}/`);
      return reply.code(204).send();
    });
  });

  // ---- Content ---------------------------------------------------------

  const content = Fastify({ logger: false });

  content.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=()');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return payload;
  });

  content.get('/healthz', async () => ({ ok: true }));

  content.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    // Relative links in the page resolve against the folder, so add the slash.
    if (!ID_PATTERN.test(req.params.id)) return notFound(reply);
    return reply.redirect(`./${req.params.id}/`, 301);
  });

  content.get<{ Params: { id: string; '*': string } }>('/:id/*', async (req, reply) => {
    const { id } = req.params;
    const artifact = await load(id);
    if (!artifact) return notFound(reply);
    const version = latest(artifact);
    // Already percent-decoded by the router; decoding again would break names with "%".
    let path = req.params['*'];
    if (path === '' || path.endsWith('/')) path += path === '' ? version.entry : 'index.html';
    const file = version.files.find((f) => f.path === path);
    if (!file) return notFound(reply);
    const etag = `"${file.sha256}"`;
    const own = `${publicUrl}/${id}/`;
    reply.header('Content-Security-Policy', artifactPolicy(own));
    reply.header('Cache-Control', 'no-cache');
    reply.header('ETag', etag);
    if (artifact.visibility !== 'public') reply.header('X-Robots-Tag', 'noindex, nofollow');
    if (file.type === DOWNLOAD_TYPE) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const body = await storage.get(objectKey(id, version.n, path));
    if (!body) return notFound(reply);
    return reply.type(file.type).send(Buffer.from(body));
  });

  content.setNotFoundHandler((_req, reply) => notFound(reply));

  return { api, content };
}

/**
 * The CSP a published page runs under. `sandbox` without `allow-same-origin`
 * gives it an opaque origin; every source is its own folder (a path-scoped
 * source), so it loads nothing from other artifacts or other sites.
 */
export function artifactPolicy(own: string): string {
  const self = `${own} data: blob:`;
  return [
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
    `default-src ${self}`,
    `script-src ${self} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self}`,
    `font-src ${self}`,
    `media-src ${self}`,
    `connect-src ${own}`,
    "frame-src 'none'",
    "worker-src blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function notFound(reply: FastifyReply) {
  return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
}

function latest(a: StoredArtifact): StoredVersion {
  return a.versions[a.versions.length - 1];
}

function defaultEntry(paths: string[]): string | undefined {
  if (paths.includes('index.html')) return 'index.html';
  return paths.length === 1 ? paths[0] : undefined;
}

function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 26 base32 characters from 130 random bits. */
export function randomId(): string {
  const bytes = randomBytes(17);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    // Fewer than 13 bits are ever pending, so keep only those.
    value = ((value << 8) | b) & 0x1fff;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${Math.round(n / 1024)} KB`;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type {
  RemoteSkill,
  SkillFetchResult,
  SkillPreview,
  SkillRepoHit,
  SkillSearchResult,
  SkillSourceListing,
  SkillSourceRepo,
} from '@nekko-agent/shared';
import {
  PROPRIETARY_REASON,
  SKILL_NAME_RE,
  classifyLicenseText,
  githubRawUrl,
  githubTreeUrl,
  matchRemoteSkill,
  normalizeRepo,
  parseGitHubLocation,
  parseSkillMarkdown,
  remoteSkillId,
  remoteToMarketSkill,
  skillSources,
} from '@nekko-agent/shared';
import { dataDir, getSettings } from './store.js';

/**
 * Skills from GitHub (the Marketplace's GitHub shelves, install-from-URL and
 * search). Host-side so it works in every edition (the renderer cannot fetch
 * cross-origin). The network is only touched when the user asks: loading or
 * refreshing a shelf, previewing a URL, searching, or installing. A loaded
 * shelf is cached in `skill-sources.json` and shown from there afterwards.
 *
 * Unauthenticated GitHub API calls are limited to 60 an hour, so a shelf costs
 * three (repo, tree, root license) plus one per skill folder that has its own
 * LICENSE file. With a GitHub token (Connectors, `GH_TOKEN`, `GITHUB_TOKEN`)
 * the limit is 5,000 and search can look inside SKILL.md files.
 */

const FETCH_TIMEOUT_MS = 10_000;
/** A SKILL.md larger than this is refused (same limit as imported skills). */
export const MAX_REMOTE_SKILL_BYTES = 256 * 1024;
/** Skills listed per shelf, at most. */
const MAX_PER_SOURCE = 200;

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}>;

export interface SkillSourceDeps {
  fetch?: Fetch;
  token?: string | null;
  /** Directory for the cache file (tests). */
  dir?: string;
}

function githubToken(): string | undefined {
  const conn = getSettings().connectors?.find((c) => c.kind === 'github' && c.connected && c.token);
  return conn?.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

function ctx(deps: SkillSourceDeps = {}) {
  const doFetch: Fetch =
    deps.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }) as never);
  const token = deps.token === undefined ? githubToken() : deps.token ?? undefined;
  const api = async (path: string): Promise<any> => {
    const res = await doFetch(`https://api.github.com/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'nekko-agent',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error(apiError(res.status, !!token));
    return res.json();
  };
  const raw = async (url: string): Promise<string | null> => {
    const res = await doFetch(url);
    if (!res.ok) return null;
    return res.text();
  };
  return { api, raw, token, dir: deps.dir };
}

function apiError(status: number, authed: boolean): string {
  if (status === 404) return 'Not found on GitHub (a private repository needs a GitHub token in Connectors).';
  if (status === 401) return 'GitHub rejected the token. Reconnect GitHub in Connectors.';
  if (status === 403 || status === 429)
    return authed ? 'GitHub rate limit reached. Try again later.' : 'GitHub rate limit reached (60 requests an hour without a token). Connect GitHub in Connectors to raise it.';
  return `GitHub request failed (${status}).`;
}

// --- cache ---

function cacheFile(dir?: string): string {
  const d = dir ?? dataDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return join(d, 'skill-sources.json');
}

type Cache = Record<string, Omit<SkillSourceListing, 'source' | 'state'>>;

function readCache(dir?: string): Cache {
  try {
    const c = JSON.parse(readFileSync(cacheFile(dir), 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? (c as Cache) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Cache, dir?: string): void {
  writeFileSync(cacheFile(dir), JSON.stringify(cache, null, 2), 'utf8');
}

const keyOf = (s: SkillSourceRepo) => `${s.repo}@${s.ref ?? ''}:${s.path ?? ''}`;

// --- listing ---

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

/** Repo metadata + every SKILL.md folder in its tree (under `under`). */
async function scanRepo(c: ReturnType<typeof ctx>, repo: string, ref: string | undefined, under: string) {
  const meta = await c.api(`repos/${repo}`);
  const branch = ref || String(meta.default_branch || 'main');
  const tree = await c.api(`repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const entries: TreeEntry[] = Array.isArray(tree.tree) ? tree.tree : [];
  const prefix = under ? `${under}/` : '';
  const inScope = (p: string) => !under || p === under || p.startsWith(prefix);
  const folders = entries
    .filter((e) => e.type === 'blob' && /(^|\/)SKILL\.md$/.test(e.path) && inScope(e.path))
    .map((e) => e.path.replace(/\/?SKILL\.md$/, ''))
    .slice(0, MAX_PER_SOURCE);
  const files = new Set(entries.filter((e) => e.type === 'blob').map((e) => e.path));
  return {
    branch,
    stars: typeof meta.stargazers_count === 'number' ? meta.stargazers_count : undefined,
    spdx: meta.license?.spdx_id && meta.license.spdx_id !== 'NOASSERTION' ? String(meta.license.spdx_id) : undefined,
    folders,
    files,
    truncated: !!tree.truncated,
  };
}

/** License of one skill folder: its own LICENSE file wins over the repo's. */
async function folderLicense(
  c: ReturnType<typeof ctx>,
  repo: string,
  branch: string,
  folder: string,
  files: Set<string>,
  repoLicense: string | undefined,
  memo: Map<string, { label: string; proprietary: boolean }>,
) {
  const own = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].map((f) => (folder ? `${folder}/${f}` : f)).find((f) => files.has(f));
  if (!own) return repoLicense ? { label: repoLicense, proprietary: false } : { label: 'none declared', proprietary: false };
  const hit = memo.get(own);
  if (hit) return hit;
  const text = await c.raw(githubRawUrl(repo, branch, own)).catch(() => null);
  const res = text ? classifyLicenseText(text) : { label: repoLicense ?? 'unknown', proprietary: false };
  memo.set(own, res);
  return res;
}

/**
 * Build one shelf's entries. Names and descriptions come from each SKILL.md's
 * frontmatter, so every listed skill costs one raw fetch (not counted against
 * the API limit).
 */
async function listRepo(c: ReturnType<typeof ctx>, source: SkillSourceRepo) {
  const scan = await scanRepo(c, source.repo, source.ref, source.path ?? '');
  const memo = new Map<string, { label: string; proprietary: boolean }>();
  const skills: RemoteSkill[] = [];
  for (const folder of scan.folders) {
    const md = await c.raw(githubRawUrl(source.repo, scan.branch, folder ? `${folder}/SKILL.md` : 'SKILL.md')).catch(() => null);
    if (!md) continue;
    const parsed = parseSkillMarkdown(md);
    const name = parsed.name ?? folder.split('/').pop() ?? source.repo.split('/')[1];
    if (!SKILL_NAME_RE.test(name)) continue;
    const lic = await folderLicense(c, source.repo, scan.branch, folder, scan.files, scan.spdx, memo);
    const extraFiles = [...scan.files].some((f) => f !== `${folder}/SKILL.md` && (folder ? f.startsWith(`${folder}/`) : false) && !/\/LICENSE(\.txt|\.md)?$/.test(f));
    skills.push({
      id: remoteSkillId(source.repo, folder),
      name,
      description: parsed.description ?? '',
      repo: source.repo,
      ref: scan.branch,
      path: folder,
      sourceUrl: githubTreeUrl(source.repo, scan.branch, folder),
      license: lic.label,
      blocked: lic.proprietary ? PROPRIETARY_REASON : undefined,
      extraFiles,
      stars: scan.stars,
    });
  }
  return { skills, stars: scan.stars, license: scan.spdx };
}

/**
 * Every configured shelf. Without `refresh` this never touches the network:
 * each shelf comes from the cache (`cached`) or is empty (`none`) until the
 * user loads it. `refresh` re-fetches either one repo or all of them.
 */
export async function listSkillSources(
  refresh?: boolean | string,
  deps: SkillSourceDeps = {},
  sources: SkillSourceRepo[] = skillSources(getSettings()),
): Promise<SkillSourceListing[]> {
  const cache = readCache(deps.dir);
  const out: SkillSourceListing[] = [];
  let dirty = false;
  const c = refresh ? ctx(deps) : undefined;
  for (const source of sources) {
    const key = keyOf(source);
    const cached = cache[key];
    const wanted = refresh === true || (typeof refresh === 'string' && refresh === source.repo);
    if (wanted && c) {
      try {
        const live = await listRepo(c, source);
        const entry = { ...live, fetchedAt: Date.now() };
        cache[key] = entry;
        dirty = true;
        out.push({ source, ...entry, state: 'live' });
      } catch (e) {
        out.push({ source, skills: cached?.skills ?? [], stars: cached?.stars, license: cached?.license, fetchedAt: cached?.fetchedAt, state: 'error', error: (e as Error).message });
      }
      continue;
    }
    out.push(cached ? { source, ...cached, state: 'cached' } : { source, skills: [], state: 'none' });
  }
  if (dirty) writeCache(cache, deps.dir);
  return out;
}

/**
 * What a pasted URL or `owner/repo` holds: one skill (a SKILL.md folder) or
 * every skill in the repo. Nothing is installed.
 */
export async function previewSkillUrl(input: string, deps: SkillSourceDeps = {}): Promise<SkillPreview> {
  const loc = parseGitHubLocation(input);
  if (!loc) return { ok: false, message: 'Paste a GitHub URL (github.com/owner/repo/tree/…/skill) or owner/repo.', skills: [] };
  const c = ctx(deps);
  try {
    const { skills } = await listRepo(c, { repo: loc.repo, ref: loc.ref, path: loc.path });
    if (!skills.length) return { ok: false, message: `No SKILL.md found in ${loc.repo}${loc.path ? `/${loc.path}` : ''}.`, repo: loc.repo, skills: [] };
    return { ok: true, repo: loc.repo, skills };
  } catch (e) {
    return { ok: false, message: (e as Error).message, repo: loc.repo, skills: [] };
  }
}

/**
 * The verbatim SKILL.md of a GitHub skill, as a marketplace skill ready for
 * `installSkill`. Refuses proprietary and oversized skills.
 */
export async function fetchRemoteSkill(skill: RemoteSkill, deps: SkillSourceDeps = {}): Promise<SkillFetchResult> {
  if (skill.blocked) return { ok: false, message: skill.blocked };
  const repo = normalizeRepo(skill.repo);
  if (!repo || skill.path.split('/').some((p) => p === '..')) return { ok: false, message: 'Invalid skill location.' };
  if (!SKILL_NAME_RE.test(skill.name)) return { ok: false, message: 'Invalid skill name.' };
  const c = ctx(deps);
  const md = await c.raw(githubRawUrl(repo, skill.ref, skill.path ? `${skill.path}/SKILL.md` : 'SKILL.md')).catch(() => null);
  if (!md || !md.trim()) return { ok: false, message: 'Could not download SKILL.md from GitHub.' };
  if (Buffer.byteLength(md, 'utf8') > MAX_REMOTE_SKILL_BYTES) return { ok: false, message: 'SKILL.md is larger than 256 KB.' };
  if (!parseSkillMarkdown(md).body) return { ok: false, message: 'SKILL.md has no instructions.' };
  return { ok: true, skill: remoteToMarketSkill({ ...skill, id: remoteSkillId(repo, skill.path), repo }, md) };
}

/**
 * Search GitHub for skills. With a token: code search over SKILL.md files
 * (finds individual skills). Without one GitHub refuses code search, so this
 * searches repositories that look like skill collections instead and says so.
 * Shelves already loaded are filtered locally by the caller, not here.
 */
export async function searchSkills(query: string, deps: SkillSourceDeps = {}): Promise<SkillSearchResult> {
  const q = query.trim().slice(0, 120);
  if (!q) return { mode: 'repos', skills: [], repos: [] };
  const c = ctx(deps);
  if (c.token) {
    const res = await c.api(`search/code?q=${encodeURIComponent(`${q} filename:SKILL.md`)}&per_page=30`);
    const seen = new Set<string>();
    const skills: RemoteSkill[] = [];
    for (const item of Array.isArray(res.items) ? res.items : []) {
      const repo = normalizeRepo(String(item.repository?.full_name ?? ''));
      const path = String(item.path ?? '').replace(/\/?SKILL\.md$/, '');
      if (!repo) continue;
      const id = remoteSkillId(repo, path);
      if (seen.has(id)) continue;
      seen.add(id);
      const name = path.split('/').pop() || repo.split('/')[1];
      if (!SKILL_NAME_RE.test(name)) continue;
      const ref = String(item.repository?.default_branch ?? 'HEAD');
      skills.push({ id, name, description: '', repo, ref, path, sourceUrl: githubTreeUrl(repo, ref, path) });
    }
    return { mode: 'code', skills, repos: [], note: 'Open a result to read its license and instructions before installing.' };
  }
  const res = await c.api(
    `search/repositories?q=${encodeURIComponent(`${q} in:name,description,topics topic:agent-skills`)}&sort=stars&per_page=20`,
  );
  let items: any[] = Array.isArray(res.items) ? res.items : [];
  if (!items.length) {
    const broad = await c.api(`search/repositories?q=${encodeURIComponent(`${q} skills SKILL.md in:name,description,readme`)}&sort=stars&per_page=20`);
    items = Array.isArray(broad.items) ? broad.items : [];
  }
  const repos: SkillRepoHit[] = items.flatMap((r) => {
    const repo = normalizeRepo(String(r.full_name ?? ''));
    if (!repo) return [];
    return [{ repo, description: r.description ?? undefined, stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : undefined, url: `https://github.com/${repo}` }];
  });
  return {
    mode: 'repos',
    skills: [],
    repos,
    note: 'Searching repositories. Connect GitHub in Connectors to search inside SKILL.md files.',
  };
}

/** Filter already-loaded shelves (no network). */
export function filterListings(listings: SkillSourceListing[], query: string): RemoteSkill[] {
  return listings.flatMap((l) => l.skills).filter((s) => matchRemoteSkill(s, query));
}

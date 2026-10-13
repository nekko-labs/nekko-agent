/**
 * Skills from GitHub: install a skill from a pasted URL, browse repositories
 * that publish Agent Skills (agentskills.io layout: a folder with SKILL.md),
 * and search GitHub for more.
 *
 * Nothing here is bundled: every third-party skill is fetched from its own
 * repository when the user asks (Load, Refresh, Preview, Install), so the
 * text stays its author's and is never copied into our catalog. A skill whose
 * license reserves all rights (Anthropic's document skills, for example) is
 * listed with a link but cannot be installed.
 */

import type { MarketplaceSkill } from './skills-market.js';
import type { SkillCategory } from './skills.js';
import { parseSkillMarkdown } from './skill-markdown.js';

/** A GitHub repository the Marketplace shows as a shelf. */
export interface SkillSourceRepo {
  /** `owner/repo`. */
  repo: string;
  /** Shelf title; defaults to the repo. */
  label?: string;
  /** Branch or tag; defaults to the repo's default branch. */
  ref?: string;
  /** Only look for skills under this folder. */
  path?: string;
}

/**
 * Shelves shown before the user changes anything. Picked for being large,
 * maintained, and openly licensed (anthropics/skills is mixed: its document
 * skills are proprietary and show as link-only).
 */
export const DEFAULT_SKILL_SOURCES: SkillSourceRepo[] = [
  { repo: 'anthropics/skills', label: 'Anthropic', path: 'skills' },
  { repo: 'obra/superpowers', label: 'Superpowers', path: 'skills' },
  { repo: 'addyosmani/agent-skills', label: 'Addy Osmani', path: 'skills' },
];

/** The configured shelves (`settings.skillSources`, else the defaults). */
export function skillSources(settings: { skillSources?: SkillSourceRepo[] } | null | undefined): SkillSourceRepo[] {
  return settings?.skillSources ?? DEFAULT_SKILL_SOURCES;
}

/** Where a skill lives on GitHub. */
export interface RemoteSkillRef {
  repo: string;
  ref: string;
  /** Folder holding SKILL.md, relative to the repo root ('' for the root). */
  path: string;
}

/** A skill found on GitHub, before it is fetched for install. */
export interface RemoteSkill extends RemoteSkillRef {
  id: string;
  name: string;
  description: string;
  /** github.com page for the skill folder. */
  sourceUrl: string;
  /** SPDX id or a short label (e.g. "Apache-2.0", "proprietary", "none declared"). */
  license?: string;
  /** Set when the skill cannot be installed (e.g. its license reserves all rights). */
  blocked?: string;
  /** The folder ships more than SKILL.md (scripts, references) that is not installed. */
  extraFiles?: boolean;
  /** Repository stars when the listing was fetched. */
  stars?: number;
}

/** One shelf: a repository's skills, as last fetched. */
export interface SkillSourceListing {
  source: SkillSourceRepo;
  skills: RemoteSkill[];
  stars?: number;
  license?: string;
  /** `none` until the user loads it for the first time. */
  state: 'live' | 'cached' | 'none' | 'error';
  fetchedAt?: number;
  error?: string;
}

/** A repository found by search that may hold skills. */
export interface SkillRepoHit {
  repo: string;
  description?: string;
  stars?: number;
  url: string;
}

export interface SkillSearchResult {
  /** `code` searched SKILL.md files (needs a GitHub token), `repos` searched repositories. */
  mode: 'code' | 'repos';
  skills: RemoteSkill[];
  repos: SkillRepoHit[];
  /** Why results are limited, shown under the results. */
  note?: string;
}

export interface SkillPreview {
  ok: boolean;
  message?: string;
  repo?: string;
  skills: RemoteSkill[];
}

export type SkillFetchResult = { ok: true; skill: MarketplaceSkill } | { ok: false; message: string };

/** A skill name we accept (matches the install check). */
export const SKILL_NAME_RE = /^[a-z0-9._-]+$/i;

const REPO_PART = /^[A-Za-z0-9_.-]+$/;

/** Validate and normalise `owner/repo`. */
export function normalizeRepo(raw: string): string | null {
  const parts = raw.trim().replace(/\.git$/, '').split('/');
  if (parts.length !== 2 || !parts.every((p) => REPO_PART.test(p) && p !== '.' && p !== '..')) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** A folder path inside a repo, without leading/trailing slashes, refusing `..`. */
function cleanPath(p: string): string | null {
  const parts = p.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (parts.some((s) => s === '..' || s === '.' || s.includes('\\'))) return null;
  return parts.join('/');
}

/** What a pasted GitHub location points at. */
export interface GitHubLocation {
  repo: string;
  ref?: string;
  /** Folder inside the repo ('' = root). A pasted SKILL.md path resolves to its folder. */
  path: string;
}

/**
 * Parse what a user pastes: `owner/repo`, a github.com repo/tree/blob URL, or a
 * raw.githubusercontent.com SKILL.md URL. A ref with a slash in it (a branch
 * named `feat/x`) cannot be told apart from a path in a tree URL; the first
 * segment is taken as the ref, like github.com's own links usually are.
 */
export function parseGitHubLocation(input: string): GitHubLocation | null {
  const raw = input.trim();
  if (!raw) return null;
  const short = normalizeRepo(raw);
  if (short && !raw.includes(':')) return { repo: short, path: '' };

  // `new URL` resolves `..` segments, which can silently turn a pasted link
  // into a different repository. Refuse dot segments (plain or encoded) first.
  const scheme = raw.indexOf('://');
  let rawPath = scheme >= 0 ? raw.slice(scheme + 3) : raw;
  const cut = rawPath.search(/[?#]/);
  if (cut >= 0) rawPath = rawPath.slice(0, cut);
  const DOT = new Set(['.', '..', '%2e', '%2e%2e', '.%2e', '%2e.']);
  if (rawPath.split('/').some((p) => DOT.has(p.toLowerCase()))) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const seg = url.pathname.split('/').filter(Boolean);
  const stripSkillMd = (parts: string[]) => (parts.length && /^skill\.md$/i.test(parts[parts.length - 1]) ? parts.slice(0, -1) : parts);

  if (url.hostname === 'raw.githubusercontent.com') {
    if (seg.length < 3) return null;
    const repo = normalizeRepo(`${seg[0]}/${seg[1]}`);
    // raw URLs may carry refs/heads/<branch>.
    let rest = seg.slice(2);
    let ref = rest[0];
    if (rest[0] === 'refs' && rest[1] === 'heads' && rest[2]) {
      ref = rest[2];
      rest = rest.slice(3);
    } else rest = rest.slice(1);
    const path = cleanPath(stripSkillMd(rest).join('/'));
    return repo && path !== null ? { repo, ref, path } : null;
  }

  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  if (seg.length < 2) return null;
  const repo = normalizeRepo(`${seg[0]}/${seg[1]}`);
  if (!repo) return null;
  if (seg.length === 2) return { repo, path: '' };
  if ((seg[2] === 'tree' || seg[2] === 'blob') && seg[3]) {
    const path = cleanPath(stripSkillMd(seg.slice(4)).join('/'));
    return path === null ? null : { repo, ref: seg[3], path };
  }
  return { repo, path: '' };
}

/** Lowercase kebab id fragment. */
function slugify(s: string): string {
  // Split on non-alphanumerics instead of trimming dashes with a regex
  // (CodeQL: polynomial regex on long runs of '-').
  return s
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter(Boolean)
    .join('-');
}

/** Stable id for a GitHub skill: `gh-<owner>-<repo>-<folder>`. */
export function remoteSkillId(repo: string, path: string): string {
  const folder = path.split('/').filter(Boolean).pop() ?? '';
  return ['gh', slugify(repo.replace('/', '-')), slugify(folder) || 'root'].join('-');
}

/** github.com page for a folder. */
export function githubTreeUrl(repo: string, ref: string, path: string): string {
  return `https://github.com/${repo}/tree/${encodeURIComponent(ref)}${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`;
}

/** raw.githubusercontent.com URL of a file. */
export function githubRawUrl(repo: string, ref: string, file: string): string {
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

const OPEN_LICENSE =
  /\b(MIT License|Apache License|BSD|Mozilla Public License|GNU (?:Affero |Lesser )?General Public License|ISC License|The Unlicense|Creative Commons|CC0|CC BY)\b|Permission is hereby granted, free of charge/i;

/**
 * Classify a LICENSE file's text. `proprietary` when it reserves all rights
 * and grants no recognised open license.
 */
export function classifyLicenseText(text: string): { label: string; proprietary: boolean } {
  const open = OPEN_LICENSE.exec(text);
  if (open) {
    const t = open[0].toLowerCase();
    const label = t.includes('apache')
      ? 'Apache-2.0'
      : t.includes('mit') || t.startsWith('permission is hereby')
        ? 'MIT'
        : t.includes('bsd')
          ? 'BSD'
          : t.includes('mozilla')
            ? 'MPL-2.0'
            : t.includes('general public')
              ? 'GPL'
              : t.includes('isc')
                ? 'ISC'
                : t.includes('unlicense')
                  ? 'Unlicense'
                  : 'CC';
    return { label, proprietary: false };
  }
  if (/all rights reserved/i.test(text)) return { label: 'proprietary', proprietary: true };
  return { label: 'custom', proprietary: false };
}

/** Why a proprietary skill is shown but not installable. */
export const PROPRIETARY_REASON = 'Its license reserves all rights, so Nekko Agent links to it instead of installing a copy.';

/** Category for a skill found on GitHub: a best guess from its name and description. */
export function remoteCategory(name: string, description: string): SkillCategory {
  const t = `${name} ${description}`.toLowerCase();
  if (/review|debug|test|lint|security|refactor|quality|simplif|bug/.test(t)) return 'Code quality';
  if (/release|commit|deploy|ship|changelog|branch|pull request|ci\b|cd\b/.test(t)) return 'Delivery';
  if (/plan|research|brainstorm|design|spec|architect|idea/.test(t)) return 'Research & planning';
  return 'Automation';
}

/**
 * A GitHub skill as a marketplace skill. With the SKILL.md it carries the
 * verbatim file (installed as-is, like Vaizer skills); without it, just enough
 * to show a card.
 */
export function remoteToMarketSkill(r: RemoteSkill, skillMd?: string): MarketplaceSkill {
  const parsed = skillMd ? parseSkillMarkdown(skillMd) : undefined;
  const description = parsed?.description ?? r.description;
  return {
    id: r.id,
    name: r.name,
    description,
    author: r.repo.split('/')[0],
    source: 'github',
    tier: 'community',
    category: remoteCategory(r.name, description),
    url: r.sourceUrl,
    stars: r.stars,
    template: `Use the ${r.name} skill. ${description}\n\n`,
    instructions: parsed?.body || description,
    markdown: skillMd,
    remote: { repo: r.repo, ref: r.ref, path: r.path },
    license: r.license,
    blocked: r.blocked,
    extraFiles: r.extraFiles,
  };
}

/** Case-insensitive match of a query against a remote skill, for offline filtering of loaded shelves. */
export function matchRemoteSkill(r: { name: string; description: string; repo?: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return q
    .split(/\s+/)
    .every((w) => r.name.toLowerCase().includes(w) || r.description.toLowerCase().includes(w) || (r.repo ?? '').toLowerCase().includes(w));
}

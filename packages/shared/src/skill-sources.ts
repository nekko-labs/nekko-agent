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

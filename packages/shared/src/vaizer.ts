/**
 * Vaizer skills integration: an optional connection to the public Agent Skills
 * marketplace at github.com/nekko-labs/vaizer (browsable at vaizer.app/skills).
 * Vaizer is a separate app; Nekko Agent only reads its machine-readable catalog and
 * installs skills the user explicitly picks.
 *
 * Offline-first: the marketplace shelf renders from the bundled snapshot
 * below with zero network. The catalog is only fetched from GitHub when the
 * user clicks "Refresh" (and a skill's SKILL.md is fetched at install time so
 * the real, current instructions are installed).
 *
 * (Until 2026-08-02 these skills lived in a separate repo,
 */

import type { MarketplaceSkill } from './skills-market.js';
import type { SkillCategory } from './skills.js';

/** Trust tiers from the Vaizer repo. Official = built + reviewed by Nekko Labs. */
export type VaizerTier = 'nekko-official' | 'community';

/** One entry of the Vaizer repo's catalog.json. */
export interface VaizerCatalogSkill {
  id: string;
  name: string;
  slug: string;
  tier: VaizerTier;
  /** Vaizer's free-form category (research, engineering, career, ...). */
  category: string;
  description: string;
  tags?: string[];
  author: string;
  version?: string;
  license?: string;
  installCommand?: string;
  sourceUrl?: string;
}

export interface VaizerCatalog {
  marketplace: string;
  addCommand?: string;
  skills: VaizerCatalogSkill[];
  /** Where this catalog came from. */
  source: 'live' | 'cached' | 'bundled';
  /** Epoch ms of the last successful live fetch (absent for bundled). */
  fetchedAt?: number;
}

export const VAIZER_REPO = 'nekko-labs/vaizer';
export const VAIZER_REPO_URL = `https://github.com/${VAIZER_REPO}`;
export const VAIZER_SITE_URL = 'https://vaizer.app/skills';
export const VAIZER_CATALOG_URL = `https://raw.githubusercontent.com/${VAIZER_REPO}/main/catalog.json`;

/**
 * Bundled snapshot of the Vaizer catalog so the shelf works fully offline.
 * Kept in sync with the repo's catalog.json when the integration is touched
 * (last synced 2026-10-09, from nekko-labs/vaizer@4fd8d88).
 */
export const VAIZER_SNAPSHOT: VaizerCatalog = {
  marketplace: 'vaizer',
  addCommand: '/plugin marketplace add nekko-labs/vaizer',
  source: 'bundled',
  skills: [
    {
      id: 'domain-finder',
      name: 'Domain Finder',
      slug: 'domain-finder',
      tier: 'nekko-official',
      category: 'research',
      description:
        'Brainstorm startup/project names, check domain availability across TLDs via RDAP, and vet brand/trademark conflicts.',
      tags: ['domains', 'naming', 'branding', 'rdap', 'startup', 'trademark'],
      author: 'Nekko Labs',
      version: '1.0.0',
      license: 'MIT',
      installCommand: '/plugin install vaizer@vaizer',
      sourceUrl: `${VAIZER_REPO_URL}/tree/main/plugins/vaizer/skills/domain-finder`,
    },
    {
      id: 'nyaa',
      name: 'nyaa',
      slug: 'nyaa',
      tier: 'nekko-official',
      category: 'engineering',
      description:
        'Five reviewer cats read your PR or working diff, one lens each. The first checks the code against what the PR description promised and against SPEC.md; the rest cover security, dependencies, correctness, and style. Choose which cats sit, and external bot reviews fold into a single verdict.',
      tags: ['code-review', 'pull-request', 'pr-description', 'spec', 'spec-conformance', 'product-intent', 'security', 'dependencies', 'supply-chain', 'concurrency', 'lint'],
      author: 'Nekko Labs',
      version: '1.3.0',
      license: 'MIT',
      installCommand: '/plugin install vaizer@vaizer',
      sourceUrl: `${VAIZER_REPO_URL}/tree/main/plugins/vaizer/skills/nyaa`,
    },
    {
      id: 'resume-checker',
      name: 'Resume Checker',
      slug: 'resume-checker',
      tier: 'nekko-official',
      category: 'career',
      description:
        'Check a resume against automated candidate-screening (ATS) signals and AI-centric job expectations, score it against specific job postings, then interactively apply fixes and show exactly what changed.',
      tags: ['resume', 'cv', 'ats', 'job-hunt', 'career', 'screening', 'ai-roles'],
      author: 'Nekko Labs',
      version: '1.0.0',
      license: 'MIT',
      installCommand: '/plugin install vaizer@vaizer',
      sourceUrl: `${VAIZER_REPO_URL}/tree/main/plugins/vaizer/skills/resume-checker`,
    },
    {
      id: 'codereview-spec',
      name: 'codereview-spec',
      slug: 'codereview-spec',
      tier: 'nekko-official',
      category: 'engineering',
      description:
        'Reviews a change against what its PR description promised and against your spec, then reviews the spec itself. Catches stated goals the code does not actually deliver, features shipped without a spec update, and the gaps in the spec that let them through.',
      tags: ['code-review', 'spec', 'spec-conformance', 'product-intent', 'pr-description', 'drift', 'documentation', 'pull-request'],
      author: 'Nekko Labs',
      version: '1.2.0',
      license: 'MIT',
      installCommand: '/plugin install vaizer@vaizer',
      sourceUrl: `${VAIZER_REPO_URL}/tree/main/plugins/vaizer/skills/codereview-spec`,
    },
  ],
};

/** Map Vaizer's free-form category onto Nekko Agent's skill categories. */
export function vaizerCategory(cat: string): SkillCategory {
  const c = cat.toLowerCase();
  if (/research|planning|naming|brainstorm|career|resume|job/.test(c)) return 'Research & planning';
  if (/engineering|review|quality|security|test|lint/.test(c)) return 'Code quality';
  if (/delivery|release|ship|deploy|docs/.test(c)) return 'Delivery';
  return 'Automation';
}

/** Strip YAML frontmatter from a SKILL.md, returning { frontmatter, body }. */
export function splitSkillMd(md: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { frontmatter: '', body: md.trim() };
  return { frontmatter: m[1], body: md.slice(m[0].length).trim() };
}

/**
 * A Vaizer catalog entry as a marketplace skill. When the full SKILL.md is
 * available (fetched at install time) it rides along verbatim as `markdown`
 * so file-based installs get the real skill, not a summary.
 */
export function vaizerToMarketSkill(d: VaizerCatalogSkill, skillMd?: string): MarketplaceSkill {
  const body = skillMd ? splitSkillMd(skillMd).body : undefined;
  const id = `vaizer-${d.id}`;
  return {
    id,
    // Installed skills are invoked as /<name>; use the slug (already kebab-case).
    name: d.slug,
    description: d.description,
    author: d.author,
    source: 'vaizer',
    tier: d.tier,
    category: vaizerCategory(d.category),
    url: d.sourceUrl ?? VAIZER_REPO_URL,
    template: `Use the ${d.name} skill. ${d.description}\n\n`,
    instructions: body ?? d.description,
    markdown: skillMd,
  };
}

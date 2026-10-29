/**
 * Skills marketplace: a curated catalog of installable skills, browsable from
 * the Skills tab. Skills come from three shelves:
 *
 *  - **Nekko Labs**, first-party skills we author and maintain.
 *  - **Popular online**, our own short versions of well-known skills from
 *    around the ecosystem (obra/superpowers, Anthropic's skills repo, the
 *    Conventional Commits spec), ranked by the public metrics of the original
 *    (GitHub stars). The text is ours and credited to Nekko Labs; the original
 *    is linked as a reference (`basedOn`), never copied. The catalog ships as a
 *    curated, offline-first snapshot so the marketplace works with no internet.
 *  - **Installed**, what the user has installed, and where.
 *
 * A skill can be installed into **Nekko Agent** itself (it joins the `/` menu and
 * the Skills tab) or exported to another agent app that reads the SKILL.md
 * convention (Claude Code `~/.claude/skills`, Codex `~/.codex/skills`).
 */

import type { SkillCategory, SkillDef, SkillWorkflow } from './skills.js';
import { parseSkillMarkdown } from './skill-markdown.js';

export type SkillSource = 'nekkolabs' | 'community' | 'vaizer' | 'github';

/** Where a skill can be installed. */
export type InstallTarget = 'nekko-agent' | 'claude' | 'codex';

/** Every value accepted for a target (drives the MCP enum). */
export const INSTALL_TARGETS: readonly string[] = [
  'nekko-agent',
  'claude',
  'codex',
];

/** Resolve a caller-supplied target onto a known one. */
export function normalizeInstallTarget(target: string | undefined): InstallTarget {
  if (!target || !INSTALL_TARGETS.includes(target)) return 'nekko-agent';
  return target as InstallTarget;
}

export interface InstallTargetInfo {
  id: InstallTarget;
  label: string;
  /** Where the install lands, shown in the UI. */
  hint: string;
  /** Whether the host detected this target on the machine. */
  available: boolean;
  /** Resolved directory for file-based targets. */
  dir?: string;
}

export interface MarketplaceSkill {
  id: string;
  /** Invoked as `/name` once installed into Nekko Agent. */
  name: string;
  description: string;
  author: string;
  source: SkillSource;
  category: SkillCategory;
  /** Homepage / repo, opened from the card. */
  url?: string;
  /**
   * The original skill or spec this one is a summary of, linked as a reference
   * only. Its text is not copied: `author` is whoever wrote *our* text.
   */
  basedOn?: string;
  /** Public metric snapshots used for the "popular" ranking. */
  stars?: number;
  installs?: number;
  tools?: string[];
  /**
   * Short task prompt. Inside Nekko Agent it is sent last, after the full
   * instructions (see `marketSkillPrompt`), so the user's input follows it.
   */
  template: string;
  /**
   * Longer instructions: written to SKILL.md for file-based installs and sent
   * to the model ahead of `template` when run inside Nekko Agent.
   */
  instructions: string;
  /** Optional bespoke workflow graph; `marketWorkflow` derives one otherwise. */
  workflow?: SkillWorkflow;
  /** Trust tier for skills from the Vaizer hub (GitHub skills are always `community`). */
  tier?: 'nekko-official' | 'community';
  /**
   * Verbatim SKILL.md for skills sourced outside the built-in catalog
   * (Vaizer). File-based installs write this instead of a generated summary.
   */
  markdown?: string;
  /** Where a skill installed from GitHub came from (see `skill-sources.ts`). */
  remote?: { repo: string; ref: string; path: string };
  /** License of a GitHub skill as detected at listing time. */
  license?: string;
  /** Set when a GitHub skill is shown but cannot be installed (e.g. proprietary). */
  blocked?: string;
  /** A GitHub skill's folder ships more than SKILL.md; only SKILL.md is installed. */
  extraFiles?: boolean;
}

/** One installed copy of a skill (a skill can be installed to several targets). */
export interface InstalledSkillRecord {
  skillId: string;
  target: InstallTarget;
  /** Directory written for file-based targets (claude/codex). */
  path?: string;
  installedAt: number;
  /**
   * Snapshot of the skill for installs that aren't in the built-in catalog
   * (e.g. Vaizer skills), so they stay runnable after install.
   */
  skill?: MarketplaceSkill;
}

/** First-party skills by Nekko Labs. */
export const NEKKO_SKILLS: MarketplaceSkill[] = [
  {
    id: 'nekko-agent-review-council',
    name: 'review-council',
    description: 'Summon a council of specialised reviewers over your diff: correctness, security, and simplicity, each reporting separately',
    author: 'Nekko Labs',
    source: 'nekkolabs',
    category: 'Code quality',
    url: 'https://github.com/nekko-labs/nekko-agent',
    installs: 4820,
    tools: ['git diff', 'read_file', 'spawn_agent'],
    template: 'Run a review council over the current changes: spawn three parallel reviewers (correctness bugs, security, simplification), then merge their findings into one ranked report.',
    instructions:
      'Review the working diff with a council of three parallel reviewer agents, each with one lens: (1) correctness bugs and edge cases, (2) security (injection, auth, secrets, unsafe input), (3) simplification and reuse. Spawn them with spawn_agent, give each the diff, then merge their findings into a single report ranked by severity, dropping duplicates. Verify each finding against the code before reporting it.',
    workflow: {
      nodes: [
        { id: 't', kind: 'trigger', label: '/review-council' },
        { id: 'ctx', kind: 'context', label: 'Load diff', detail: 'Changed files + context' },
        { id: 'r1', kind: 'agent', label: 'Correctness cat', detail: 'Bugs + edge cases' },
        { id: 'r2', kind: 'agent', label: 'Security cat', detail: 'Injection, auth, secrets' },
        { id: 'r3', kind: 'agent', label: 'Simplicity cat', detail: 'Reuse + clarity' },
        { id: 'merge', kind: 'agent', label: 'Merge findings', detail: 'Dedupe + rank by severity' },
        { id: 'out', kind: 'output', label: 'Council report' },
      ],
      edges: [
        { from: 't', to: 'ctx' },
        { from: 'ctx', to: 'r1' },
        { from: 'ctx', to: 'r2' },
        { from: 'ctx', to: 'r3' },
        { from: 'r1', to: 'merge' },
        { from: 'r2', to: 'merge' },
        { from: 'r3', to: 'merge' },
        { from: 'merge', to: 'out' },
      ],
    },
  },
  {
    id: 'nekko-agent-spec-sync',
    name: 'spec-sync',
    description: 'Reconcile SPEC.md with the code: find shipped features the spec missed and spec promises the code broke',
    author: 'Nekko Labs',
    source: 'nekkolabs',
    category: 'Research & planning',
    url: 'https://github.com/nekko-labs/nekko-agent',
    installs: 3110,
    tools: ['read_file', 'search'],
    template: 'Compare SPEC.md against the actual code: list shipped features the spec does not mention, and spec claims the code no longer satisfies. Then update SPEC.md to match reality.',
    instructions:
      'Read the workspace SPEC.md, then survey the codebase (entry points, routes, views, commands). Produce two lists: features that exist in code but are missing from the spec, and spec statements the code contradicts. Update SPEC.md so it describes the system as it actually is, keeping its existing voice and structure.',
  },
  {
    id: 'nekko-agent-changelog',
    name: 'changelog',
    description: 'Write a user-facing changelog entry from the commits since the last release tag',
    author: 'Nekko Labs',
    source: 'nekkolabs',
    category: 'Delivery',
    url: 'https://github.com/nekko-labs/nekko-agent',
    installs: 2740,
    tools: ['git log', 'write_file'],
    template: 'Write a user-facing changelog entry from the commits since the last release tag: group by Added / Changed / Fixed, plain language, no commit hashes.',
    instructions:
      'Run git log from the last release tag to HEAD. Group the changes into Added / Changed / Fixed sections written for end users (plain language, no commit hashes, no internal refactors unless user-visible). Prepend the entry to CHANGELOG.md with the version and date.',
  },
  {
    id: 'nekko-agent-standup',
    name: 'standup',
    description: 'Summarize what changed in this workspace since yesterday, written as a standup update',
    author: 'Nekko Labs',
    source: 'nekkolabs',
    category: 'Delivery',
    url: 'https://github.com/nekko-labs/nekko-agent',
    installs: 1980,
    tools: ['git log', 'git diff'],
    template: 'Summarize what changed in this repo in the last 24h as a standup update: done / in progress / blockers, three bullets each max.',
    instructions:
      'Inspect git log and the working tree for the last 24 hours. Write a standup update with three short sections: Done (merged/committed), In progress (uncommitted or branch work), Blockers (failing tests, TODOs, unresolved conflicts). Keep each section to three bullets.',
  },
  {
    id: 'nekko-agent-dep-audit',
    name: 'dep-audit',
    description: 'Audit dependencies for known vulnerabilities, unused packages, and majors you are behind on',
    author: 'Nekko Labs',
    source: 'nekkolabs',
    category: 'Code quality',
    url: 'https://github.com/nekko-labs/nekko-agent',
    installs: 1540,
    tools: ['bash', 'read_file'],
    template: 'Audit the dependencies: run the package manager audit, find unused packages, and list majors we are behind on, with a prioritized upgrade plan.',
    instructions:
      'Run the package manager audit (npm audit / cargo audit / pip-audit as appropriate), cross-check package manifests against actual imports to find unused dependencies, and list major versions the project is behind on. Produce a prioritized plan: security fixes first, then easy majors, then risky ones with their breaking changes.',
  },
  {
    id: 'nekko-agent-a11y-audit',
    name: 'a11y-audit',
    description: 'Audit UI code for accessibility: contrast, keyboard navigation, labels, and focus handling',
    author: 'Nekko Labs',
    source: 'nekkolabs',
    category: 'Code quality',
    url: 'https://github.com/nekko-labs/nekko-agent',
    installs: 1210,
    tools: ['read_file', 'search'],
    template: 'Audit the UI components for accessibility issues: missing labels/alt text, keyboard traps, focus handling, contrast risks. Report by severity with fixes.',
    instructions:
      'Sweep the UI components for accessibility problems: interactive elements without accessible names, missing alt text, keyboard traps or unreachable controls, missing focus styles, and color pairs likely to fail WCAG AA contrast. Report findings grouped by severity, each with the file, the problem, and a concrete fix.',
  },
  {
    // Kept its old id so existing installs still resolve. It used to sit on the
    // Popular shelf linked to anthropics/skills, which has no such skill.
    id: 'community-i18n-sweep',
    name: 'i18n-sweep',
    description: 'Find hardcoded user-facing strings and move them into the translation files',
    author: 'Nekko Labs',
    source: 'nekkolabs',
    category: 'Code quality',
    url: 'https://github.com/nekko-labs/nekko-agent',
    tools: ['search', 'edit_file'],
    template: 'Sweep the UI code for hardcoded user-facing strings, move them into the i18n catalog, and flag any that need context notes for translators.',
    instructions:
      'Search the UI code for hardcoded user-facing strings (labels, toasts, placeholders, errors). Move each into the project’s i18n catalog with a sensible key, replace the literal with the lookup, and flag strings whose meaning needs a translator note. Do not touch log lines or developer-only text.',
  },
];

/**
 * Popular skills from around the ecosystem, as our own short versions: each
 * entry's text is written by Nekko Labs and links the original it is based on.
 * Anthropic's document skills (pdf, docx, xlsx) are proprietary, so nothing of
 * theirs is copied or downloaded; we only link them.
 *
 * `stars` are the original repository's GitHub stars, snapshotted from the
 * GitHub API on 2026-10-09. They rank the shelf; they are not live.
 */
export const POPULAR_SKILLS: MarketplaceSkill[] = [
  {
    id: 'anthropic-pdf',
    name: 'pdf',
    description: 'Read, create, merge, split, and fill PDF files',
    author: 'Nekko Labs',
    source: 'community',
    category: 'Automation',
    basedOn: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    stars: 180100,
    tools: ['bash', 'read_file', 'write_file'],
    template: 'Work with the PDF file(s) I attach: extract text/tables, or create/merge/split/fill as I describe:\n\n',
    instructions:
      'Handle PDF work end to end: extract text and tables from PDFs, combine or split documents, rotate pages, fill form fields, and create new PDFs from content. Prefer well-known Python libraries (pypdf, reportlab) run via the shell; verify the output file opens cleanly.',
  },
  {
    id: 'anthropic-docx',
    name: 'docx',
    description: 'Create and edit Word documents with proper formatting, styles, and tracked changes',
    author: 'Nekko Labs',
    source: 'community',
    category: 'Automation',
    basedOn: 'https://github.com/anthropics/skills/tree/main/skills/docx',
    stars: 180100,
    tools: ['bash', 'write_file'],
    template: 'Create or edit the Word document as described, keeping professional formatting:\n\n',
    instructions:
      'Create or edit .docx files with professional formatting: headings, tables of contents, page numbers, styled tables, and letterheads. Use python-docx via the shell. When editing an existing document, preserve its styles and structure.',
  },
  {
    id: 'anthropic-xlsx',
    name: 'xlsx',
    description: 'Read, clean, analyze, and build spreadsheets with formulas and charts',
    author: 'Nekko Labs',
    source: 'community',
    category: 'Automation',
    basedOn: 'https://github.com/anthropics/skills/tree/main/skills/xlsx',
    stars: 180100,
    tools: ['bash', 'read_file', 'write_file'],
    template: 'Work with the spreadsheet as described (read/clean/compute/chart):\n\n',
    instructions:
      'Work with spreadsheet files: read and clean messy tabular data, compute columns and formulas, add charts, and produce well-formatted .xlsx output. Use openpyxl/pandas via the shell and sanity-check the numbers before delivering.',
  },
  {
    id: 'superpowers-brainstorm',
    name: 'brainstorm',
    description: 'Structured brainstorming that interrogates the problem before proposing solutions',
    author: 'Nekko Labs',
    source: 'community',
    category: 'Research & planning',
    basedOn: 'https://github.com/obra/superpowers/tree/main/skills/brainstorming',
    stars: 296700,
    tools: [],
    template: 'Brainstorm with me on the following. First interrogate the problem with clarifying questions, then propose distinct solution directions with tradeoffs:\n\n',
    instructions:
      'Run a structured brainstorm: first ask the clarifying questions that actually change the answer, then generate several genuinely distinct solution directions, each with its tradeoffs and a cheap way to validate it. Converge on a recommendation only after laying out the space.',
  },
  {
    id: 'superpowers-debug',
    name: 'systematic-debug',
    description: 'Systematic root-cause debugging: reproduce, bisect, instrument, prove the fix',
    author: 'Nekko Labs',
    source: 'community',
    category: 'Code quality',
    basedOn: 'https://github.com/obra/superpowers/tree/main/skills/systematic-debugging',
    stars: 296700,
    tools: ['read_file', 'edit_file', 'bash'],
    template: 'Debug this systematically: reproduce it first, isolate the cause (bisect/instrument), fix the root cause, and prove the fix with a test:\n\n',
    instructions:
      'Debug systematically instead of guessing: reproduce the failure first, then isolate the cause by bisecting the input/commit/code path and adding targeted instrumentation. Fix the root cause, not the symptom, and prove the fix with a test that failed before and passes after.',
    workflow: {
      nodes: [
        { id: 't', kind: 'trigger', label: '/systematic-debug' },
        { id: 'repro', kind: 'context', label: 'Reproduce', detail: 'Make it fail on demand' },
        { id: 'bisect', kind: 'loop', label: 'Isolate', detail: 'Bisect + instrument' },
        { id: 'cause', kind: 'decision', label: 'Root cause found?' },
        { id: 'fix', kind: 'tool', label: 'Apply fix' },
        { id: 'prove', kind: 'tool', label: 'Prove with test' },
        { id: 'out', kind: 'output', label: 'Fix + proof' },
      ],
      edges: [
        { from: 't', to: 'repro' },
        { from: 'repro', to: 'bisect' },
        { from: 'bisect', to: 'cause' },
        { from: 'cause', to: 'bisect', label: 'no', back: true },
        { from: 'cause', to: 'fix', label: 'yes' },
        { from: 'fix', to: 'prove' },
        { from: 'prove', to: 'out' },
      ],
    },
  },
  {
    id: 'community-conventional-commits',
    name: 'conventional-commits',
    description: 'Stage and commit with strict Conventional Commits messages, splitting unrelated changes',
    author: 'Nekko Labs',
    source: 'community',
    category: 'Delivery',
    // Stars of the spec's repo, conventional-commits/conventionalcommits.org.
    basedOn: 'https://www.conventionalcommits.org',
    stars: 9300,
    tools: ['git status', 'git diff', 'git commit'],
    template: 'Commit the current changes using Conventional Commits. Split unrelated changes into separate commits.',
    instructions:
      'Inspect the working tree and group related changes. Commit each group with a strict Conventional Commits message (type(scope): subject, imperative, <72 chars, body explaining why when non-obvious). Never mix unrelated changes in one commit.',
  },
];

export const MARKET_SKILLS: MarketplaceSkill[] = [...NEKKO_SKILLS, ...POPULAR_SKILLS];

export function getMarketSkill(id: string): MarketplaceSkill | undefined {
  return MARKET_SKILLS.find((s) => s.id === id);
}

/** Popular shelf, ranked by public metrics (stars, then installs). */
export function popularSkills(): MarketplaceSkill[] {
  return [...POPULAR_SKILLS].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || (b.installs ?? 0) - (a.installs ?? 0));
}

/** Derive a generic workflow for a marketplace skill without a bespoke graph. */
export function marketWorkflow(skill: MarketplaceSkill): SkillWorkflow {
  if (skill.workflow) return skill.workflow;
  const usesTools = (skill.tools ?? []).length > 0;
  const nodes = [
    { id: 't', kind: 'trigger' as const, label: `/${skill.name}`, detail: 'Skill invoked' },
    { id: 'ctx', kind: 'context' as const, label: 'Gather context', detail: 'Files, diff, inputs' },
    { id: 'agent', kind: 'agent' as const, label: 'Run instructions', detail: skill.description.slice(0, 48) },
    ...(usesTools ? [{ id: 'tools', kind: 'tool' as const, label: 'Use tools', detail: (skill.tools ?? []).slice(0, 3).join(', ') }] : []),
    { id: 'out', kind: 'output' as const, label: 'Deliverable' },
  ];
  const chain = nodes.map((n) => n.id);
  const edges = chain.slice(1).map((to, i) => ({ from: chain[i], to }));
  return { nodes, edges };
}

/**
 * The full instructions a marketplace skill gives the model: a Vaizer skill's
 * verbatim SKILL.md body (frontmatter stripped), else the catalog
 * `instructions`. Empty when there is nothing beyond what `template` already
 * says (e.g. a Vaizer skill installed offline, whose instructions are just its
 * description, which the template repeats).
 */
export function marketSkillInstructions(m: MarketplaceSkill): string {
  const body = ((m.markdown ? parseSkillMarkdown(m.markdown).body : '') || (m.instructions ?? '')).trim();
  if (!body || m.template.includes(body)) return '';
  return body;
}

/**
 * What reaches the model when an installed marketplace skill runs: its full
 * instructions first, then the short `template` as the task. The template
 * stays last because the user's input is appended right after it (several
 * templates end with "...as I describe:").
 */
export function marketSkillPrompt(m: MarketplaceSkill): string {
  const body = marketSkillInstructions(m);
  if (!body) return m.template;
  return [`Use the "${m.name}" skill. Its instructions:`, '', body, '', 'Task:', m.template].join('\n');
}

/** A marketplace skill as a runnable in-app SkillDef (once installed to Nekko Agent). */
export function marketToSkillDef(m: MarketplaceSkill): SkillDef {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    template: marketSkillPrompt(m),
    category: m.category,
    tools: m.tools,
    workflow: marketWorkflow(m),
  };
}

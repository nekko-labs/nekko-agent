import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKILL_SOURCES,
  classifyLicenseText,
  githubRawUrl,
  matchRemoteSkill,
  normalizeRepo,
  parseGitHubLocation,
  remoteSkillId,
  remoteToMarketSkill,
  skillSources,
} from './skill-sources.js';
import { marketSkillPrompt, skillToMarkdown } from './skills-market.js';

describe('parseGitHubLocation', () => {
  it('reads owner/repo, repo URLs, tree/blob URLs and raw SKILL.md URLs', () => {
    expect(parseGitHubLocation('obra/superpowers')).toEqual({ repo: 'obra/superpowers', path: '' });
    expect(parseGitHubLocation('https://github.com/obra/superpowers')).toEqual({ repo: 'obra/superpowers', path: '' });
    expect(parseGitHubLocation('github.com/obra/superpowers.git')).toEqual({ repo: 'obra/superpowers', path: '' });
    expect(parseGitHubLocation('https://github.com/obra/superpowers/tree/main/skills/brainstorming')).toEqual({
      repo: 'obra/superpowers',
      ref: 'main',
      path: 'skills/brainstorming',
    });
    expect(parseGitHubLocation('https://github.com/a/b/blob/v2/skills/x/SKILL.md')).toEqual({ repo: 'a/b', ref: 'v2', path: 'skills/x' });
    expect(parseGitHubLocation('https://raw.githubusercontent.com/a/b/main/skills/x/SKILL.md')).toEqual({ repo: 'a/b', ref: 'main', path: 'skills/x' });
    expect(parseGitHubLocation('https://raw.githubusercontent.com/a/b/refs/heads/dev/SKILL.md')).toEqual({ repo: 'a/b', ref: 'dev', path: '' });
    // Other pages of a repo point at the repo itself.
    expect(parseGitHubLocation('https://github.com/a/b/issues/3')).toEqual({ repo: 'a/b', path: '' });
  });

  it('refuses other hosts, malformed repos and path traversal', () => {
    expect(parseGitHubLocation('')).toBeNull();
    expect(parseGitHubLocation('https://gitlab.com/a/b')).toBeNull();
    expect(parseGitHubLocation('https://github.com/a')).toBeNull();
    expect(parseGitHubLocation('a/b/c')).toBeNull();
    // `new URL` would resolve these into another repo (`a/x`); they are refused.
    expect(parseGitHubLocation('https://github.com/a/b/tree/main/skills/%2e%2e/x')).toBeNull();
    expect(parseGitHubLocation('https://github.com/a/b/tree/main/skills/../../../x')).toBeNull();
    expect(parseGitHubLocation('https://raw.githubusercontent.com/a/b/main/../../x/SKILL.md')).toBeNull();
    expect(parseGitHubLocation('github.com/a/b/tree/main/./x')).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizes repos and builds stable ids and raw URLs', () => {
    expect(normalizeRepo(' acme/skills.git ')).toBe('acme/skills');
    expect(normalizeRepo('../x')).toBeNull();
    expect(remoteSkillId('Acme/Skills', 'skills/Code_Review')).toBe('gh-acme-skills-code-review');
    expect(remoteSkillId('acme/solo', '')).toBe('gh-acme-solo-root');
    expect(githubRawUrl('a/b', 'feat/x', 'skills/my skill/SKILL.md')).toBe('https://raw.githubusercontent.com/a/b/feat%2Fx/skills/my%20skill/SKILL.md');
  });

  it('classifies licenses: open ones by name, all-rights-reserved as proprietary', () => {
    expect(classifyLicenseText('Apache License\nVersion 2.0, January 2004')).toEqual({ label: 'Apache-2.0', proprietary: false });
    expect(classifyLicenseText('MIT License\n\nPermission is hereby granted, free of charge')).toEqual({ label: 'MIT', proprietary: false });
    expect(classifyLicenseText('© 2025 Anthropic, PBC. All rights reserved.')).toEqual({ label: 'proprietary', proprietary: true });
    expect(classifyLicenseText('Do what you like.')).toEqual({ label: 'custom', proprietary: false });
  });

  it('defaults the shelves until the user sets their own', () => {
    expect(skillSources(undefined)).toBe(DEFAULT_SKILL_SOURCES);
    expect(skillSources({ skillSources: [] })).toEqual([]);
    expect(DEFAULT_SKILL_SOURCES.map((s) => s.repo)).toContain('anthropics/skills');
  });

  it('matches every word of a query against name, description or repo', () => {
    const r = { name: 'systematic-debugging', description: 'Find root causes', repo: 'obra/superpowers' };
    expect(matchRemoteSkill(r, '')).toBe(true);
    expect(matchRemoteSkill(r, 'debug root')).toBe(true);
    expect(matchRemoteSkill(r, 'obra')).toBe(true);
    expect(matchRemoteSkill(r, 'debug pdf')).toBe(false);
  });
});

describe('remoteToMarketSkill', () => {
  const remote = { id: 'gh-acme-skills-review', name: 'review', description: 'Listed', repo: 'acme/skills', ref: 'main', path: 'skills/review', sourceUrl: 'https://github.com/acme/skills/tree/main/skills/review', license: 'MIT' };
  const file = '---\nname: review\ndescription: Review a diff carefully\n---\n\nRead the diff, then report.\n';

  it('installs the author’s verbatim SKILL.md, never a rewrite, credited to the repo owner', () => {
    const m = remoteToMarketSkill(remote, file);
    expect(m).toMatchObject({ source: 'github', tier: 'community', author: 'acme', description: 'Review a diff carefully', license: 'MIT', category: 'Code quality' });
    expect(skillToMarkdown(m)).toBe(file);
    expect(marketSkillPrompt(m)).toContain('Read the diff, then report.');
  });

  it('without the file is a card only, with no markdown to install', () => {
    const m = remoteToMarketSkill(remote);
    expect(m.markdown).toBeUndefined();
    expect(m.instructions).toBe('Listed');
  });
});

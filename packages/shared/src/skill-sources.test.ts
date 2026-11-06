import { describe, expect, it } from 'vitest';
import { DEFAULT_SKILL_SOURCES, matchRemoteSkill, remoteToMarketSkill, skillSources } from './skill-sources.js';

describe('helpers', () => {
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

  it('without the file is a card only, with no markdown to install', () => {
    const m = remoteToMarketSkill(remote);
    expect(m.markdown).toBeUndefined();
    expect(m.instructions).toBe('Listed');
  });
});

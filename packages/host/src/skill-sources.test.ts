import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchRemoteSkill, listSkillSources, MAX_REMOTE_SKILL_BYTES, previewSkillUrl, searchSkills, type Fetch } from './skill-sources';

/**
 * A fake GitHub: `api` answers api.github.com paths, `raw` answers
 * raw.githubusercontent.com paths. Every request is recorded, so the tests can
 * prove what touched the network and with which headers.
 */
function fakeGitHub(api: Record<string, unknown>, raw: Record<string, string>) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.slice(1) + u.search);
    const body = u.hostname === 'api.github.com' ? api[key] : raw[decodeURIComponent(u.pathname.slice(1))];
    const status = body === undefined ? 404 : typeof body === 'number' ? body : 200;
    return {
      ok: status === 200,
      status,
      json: async () => body,
      text: async () => String(body),
    };
  };
  return { fetch, calls };
}

const md = (name: string, description: string, body = 'Do the thing.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const REPO = {
  'repos/acme/skills': { default_branch: 'main', stargazers_count: 1234, license: { spdx_id: 'MIT' } },
  'repos/acme/skills/git/trees/main?recursive=1': {
    tree: [
      { path: 'skills/review/SKILL.md', type: 'blob' },
      { path: 'skills/review/scripts/run.sh', type: 'blob' },
      { path: 'skills/docs/SKILL.md', type: 'blob' },
      { path: 'skills/docs/LICENSE.txt', type: 'blob' },
      { path: 'other/SKILL.md', type: 'blob' },
      { path: 'README.md', type: 'blob' },
    ],
  },
};
const RAW = {
  'acme/skills/main/skills/review/SKILL.md': md('review', 'Review a diff'),
  'acme/skills/main/skills/docs/SKILL.md': md('docs', 'Write Word documents'),
  'acme/skills/main/skills/docs/LICENSE.txt': '© 2025 Acme. All rights reserved.\nUse is governed by your agreement.',
  'acme/skills/main/other/SKILL.md': md('other', 'Outside the folder'),
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-skill-sources-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sources = [{ repo: 'acme/skills', path: 'skills' }];

describe('listSkillSources', () => {
  it('never touches the network without refresh, and reports unloaded shelves', async () => {
    const gh = fakeGitHub(REPO, RAW);
    const out = await listSkillSources(undefined, { fetch: gh.fetch, token: null, dir }, sources);
    expect(gh.calls).toEqual([]);
    expect(out).toEqual([{ source: sources[0], skills: [], state: 'none' }]);
  });

  it('lists every SKILL.md under the shelf folder with names from frontmatter, license per folder, and extra files', async () => {
    const gh = fakeGitHub(REPO, RAW);
    const [shelf] = await listSkillSources(true, { fetch: gh.fetch, token: null, dir }, sources);
    expect(shelf.state).toBe('live');
    expect(shelf.stars).toBe(1234);
    expect(shelf.skills.map((s) => s.name)).toEqual(['review', 'docs']); // `other/` is outside `skills/`
    const [review, docs] = shelf.skills;
    expect(review).toMatchObject({ id: 'gh-acme-skills-review', license: 'MIT', extraFiles: true, ref: 'main', path: 'skills/review' });
    expect(review.blocked).toBeUndefined();
    expect(review.sourceUrl).toBe('https://github.com/acme/skills/tree/main/skills/review');
    // A folder's own all-rights-reserved LICENSE beats the repo's MIT.
    expect(docs).toMatchObject({ license: 'proprietary', extraFiles: false });
    expect(docs.blocked).toMatch(/reserves all rights/);
  });

  it('serves the cache afterwards with no network, and keeps it when a refresh fails', async () => {
    const gh = fakeGitHub(REPO, RAW);
    await listSkillSources(true, { fetch: gh.fetch, token: null, dir }, sources);
    expect(JSON.parse(readFileSync(join(dir, 'skill-sources.json'), 'utf8'))).toHaveProperty(['acme/skills@:skills']);

    const offline = fakeGitHub({}, {});
    const [cached] = await listSkillSources(undefined, { fetch: offline.fetch, token: null, dir }, sources);
    expect(offline.calls).toEqual([]);
    expect(cached.state).toBe('cached');
    expect(cached.skills).toHaveLength(2);

    const limited = fakeGitHub({ 'repos/acme/skills': 403 }, {});
    const [failed] = await listSkillSources(true, { fetch: limited.fetch, token: null, dir }, sources);
    expect(failed.state).toBe('error');
    expect(failed.error).toMatch(/rate limit.*Connect GitHub/);
    expect(failed.skills).toHaveLength(2);
  });

  it('refreshes only the named repo', async () => {
    const gh = fakeGitHub(REPO, RAW);
    const out = await listSkillSources('acme/skills', { fetch: gh.fetch, token: null, dir }, [...sources, { repo: 'other/repo' }]);
    expect(out.map((l) => l.state)).toEqual(['live', 'none']);
    expect(gh.calls.some((c) => c.url.includes('other/repo'))).toBe(false);
  });

  it('sends the GitHub token when one is configured', async () => {
    const gh = fakeGitHub(REPO, RAW);
    await listSkillSources(true, { fetch: gh.fetch, token: 'tok', dir }, sources);
    expect(gh.calls.filter((c) => c.url.startsWith('https://api.github.com/')).every((c) => c.auth === 'Bearer tok')).toBe(true);
    // Raw file fetches never carry it.
    expect(gh.calls.filter((c) => c.url.startsWith('https://raw.')).every((c) => !c.auth)).toBe(true);
  });
});

describe('previewSkillUrl', () => {
  it('finds one skill from a pasted tree URL', async () => {
    const gh = fakeGitHub(REPO, RAW);
    const res = await previewSkillUrl('https://github.com/acme/skills/tree/main/skills/review', { fetch: gh.fetch, token: null, dir });
    expect(res.ok).toBe(true);
    expect(res.skills.map((s) => s.name)).toEqual(['review']);
  });

  it('refuses what is not a GitHub location, without fetching', async () => {
    const gh = fakeGitHub(REPO, RAW);
    const res = await previewSkillUrl('https://example.com/acme/skills', { fetch: gh.fetch, token: null, dir });
    expect(res.ok).toBe(false);
    expect(gh.calls).toEqual([]);
  });

  it('says so when the repo has no skills, and explains a 404', async () => {
    const empty = fakeGitHub({ 'repos/acme/empty': { default_branch: 'main' }, 'repos/acme/empty/git/trees/main?recursive=1': { tree: [] } }, {});
    expect((await previewSkillUrl('acme/empty', { fetch: empty.fetch, token: null, dir })).message).toMatch(/No SKILL\.md/);
    const missing = fakeGitHub({}, {});
    expect((await previewSkillUrl('acme/private', { fetch: missing.fetch, token: null, dir })).message).toMatch(/private repository/);
  });
});

describe('fetchRemoteSkill', () => {
  const review = { id: 'x', name: 'review', description: '', repo: 'acme/skills', ref: 'main', path: 'skills/review', sourceUrl: '' };

  it('returns the verbatim SKILL.md as an installable github skill', async () => {
    const gh = fakeGitHub(REPO, RAW);
    const res = await fetchRemoteSkill(review, { fetch: gh.fetch, token: null, dir });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skill).toMatchObject({ id: 'gh-acme-skills-review', source: 'github', tier: 'community', author: 'acme', markdown: RAW['acme/skills/main/skills/review/SKILL.md'] });
    expect(res.skill.instructions).toBe('Do the thing.');
    expect(res.skill.remote).toEqual({ repo: 'acme/skills', ref: 'main', path: 'skills/review' });
  });

  it('refuses blocked, oversized, empty and path-escaping skills', async () => {
    const big = fakeGitHub({}, { 'acme/skills/main/skills/review/SKILL.md': md('review', 'x', 'a'.repeat(MAX_REMOTE_SKILL_BYTES)) });
    expect(await fetchRemoteSkill(review, { fetch: big.fetch, token: null, dir })).toMatchObject({ ok: false, message: expect.stringMatching(/256 KB/) });
    const empty = fakeGitHub({}, { 'acme/skills/main/skills/review/SKILL.md': '---\nname: review\n---\n' });
    expect(await fetchRemoteSkill(review, { fetch: empty.fetch, token: null, dir })).toMatchObject({ ok: false });

    const gh = fakeGitHub(REPO, RAW);
    expect(await fetchRemoteSkill({ ...review, blocked: 'nope' }, { fetch: gh.fetch, token: null, dir })).toEqual({ ok: false, message: 'nope' });
    expect(await fetchRemoteSkill({ ...review, path: '../etc' }, { fetch: gh.fetch, token: null, dir })).toMatchObject({ ok: false });
    expect(await fetchRemoteSkill({ ...review, repo: 'not a repo' }, { fetch: gh.fetch, token: null, dir })).toMatchObject({ ok: false });
    expect(gh.calls).toEqual([]);
  });
});

describe('searchSkills', () => {
  it('without a token searches repositories and says why', async () => {
    const q = `review in:name,description,topics topic:agent-skills`;
    const gh = fakeGitHub(
      { [`search/repositories?q=${q}&sort=stars&per_page=20`]: { items: [{ full_name: 'acme/skills', description: 'Skills', stargazers_count: 5 }, { full_name: 'bad name/x' }] } },
      {},
    );
    const res = await searchSkills('review', { fetch: gh.fetch, token: null, dir });
    expect(res.mode).toBe('repos');
    expect(res.repos).toEqual([{ repo: 'acme/skills', description: 'Skills', stars: 5, url: 'https://github.com/acme/skills' }]);
    expect(res.note).toMatch(/Connect GitHub/);
    expect(gh.calls.some((c) => c.url.includes('search/code'))).toBe(false);
  });

  it('with a token searches SKILL.md files and dedupes by folder', async () => {
    const gh = fakeGitHub(
      {
        'search/code?q=review filename:SKILL.md&per_page=30': {
          items: [
            { path: 'skills/review/SKILL.md', repository: { full_name: 'acme/skills', default_branch: 'main' } },
            { path: 'skills/review/SKILL.md', repository: { full_name: 'acme/skills', default_branch: 'main' } },
            { path: 'SKILL.md', repository: { full_name: 'solo/review-skill', default_branch: 'trunk' } },
          ],
        },
      },
      {},
    );
    const res = await searchSkills('review', { fetch: gh.fetch, token: 'tok', dir });
    expect(res.mode).toBe('code');
    expect(res.skills.map((s) => [s.id, s.name, s.ref])).toEqual([
      ['gh-acme-skills-review', 'review', 'main'],
      ['gh-solo-review-skill-root', 'review-skill', 'trunk'],
    ]);
  });

  it('does nothing for an empty query', async () => {
    const gh = fakeGitHub({}, {});
    expect(await searchSkills('   ', { fetch: gh.fetch, token: null, dir })).toEqual({ mode: 'repos', skills: [], repos: [] });
    expect(gh.calls).toEqual([]);
  });
});

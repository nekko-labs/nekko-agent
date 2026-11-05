// GitHub is contacted at deploy time only, never by a visitor's browser.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const API = 'https://api.github.com/repos/nekko-labs/nekko-agent/contributors';
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export async function loadContributors(fetcher = fetch, token = process.env.GITHUB_TOKEN) {
  const people = new Map();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'nekko-agent-website' };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let page = 1; page <= 100; page++) {
    const res = await fetcher(`${API}?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GitHub contributors answered ${res.status}`);
    const rows = res.status === 204 ? [] : await res.json();
    if (!Array.isArray(rows)) throw new Error('Invalid GitHub contributor response');
    for (const row of rows) {
      if (row.type !== 'User' || !LOGIN.test(row.login || '')) continue;
      // Derive profile links ourselves; API strings never become arbitrary links.
      people.set(row.login.toLowerCase(), { login: row.login, url: `https://github.com/${row.login}`, avatar: row.avatar_url });
    }
    if (rows.length < 100) return [...people.values()];
  }
  throw new Error('GitHub contributor pagination exceeded 100 pages');
}

export async function writeContributors(site, { fetcher = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const directory = join(site, 'contributors');
  // A failed refresh must not publish yesterday's attribution after a removal.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  let people;
  try {
    people = await loadContributors(fetcher, token);
  } catch (error) {
    writeFileSync(join(site, 'contributors.json'), JSON.stringify({ available: false, contributors: [] }) + '\n');
    return `contributors skipped (${error.message}); the GitHub contributors link remains available`;
  }
  // Bound concurrent image requests. Never send the API token to the image host.
  const contributors = [];
  for (let start = 0; start < people.length; start += 6) {
    contributors.push(...await Promise.all(people.slice(start, start + 6).map(async ({ login, url, avatar }) => {
      const person = { login, url };
      try {
        const remote = new URL(avatar);
        if (remote.origin !== 'https://avatars.githubusercontent.com') throw new Error('Unexpected avatar host');
        remote.search = '?s=112';
        const response = await fetcher(remote.href, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[response.headers.get('content-type')?.split(';')[0]];
        if (!response.ok || !ext) throw new Error('Avatar unavailable');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 1_000_000) throw new Error('Invalid avatar size');
        // The host serves images immutable, so changed avatars need new URLs.
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        const name = `${login}-${hash}.${ext}`;
        writeFileSync(join(directory, name), bytes);
        person.avatar = `/contributors/${name}`;
      } catch {
        // Keep the contributor even if GitHub's image service is unavailable.
      }
      return person;
    })));
  }
  writeFileSync(join(site, 'contributors.json'), JSON.stringify({ available: true, contributors }) + '\n');
  return `contributors.json: ${contributors.length} people`;
}

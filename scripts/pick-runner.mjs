// Picks the runner for a job: the owner's idle Mac runner, else a GitHub-hosted one.
// Never fails the workflow: no token, an API error or a bad reply all give the fallback.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function pick(runners, label, fallback) {
  const idle = runners.some((r) => r.status === 'online' && r.busy === false && (r.labels ?? []).some((l) => l.name === label));
  return JSON.stringify(idle ? ['self-hosted', label] : fallback);
}

export async function main(env = process.env, fetchFn = globalThis.fetch) {
  const label = env.PICK_LABEL || 'nekko-mac';
  const fallback = env.PICK_FALLBACK || 'macos-latest';
  const done = (value, reason) => {
    console.error(`runs-on ${value}: ${reason}`);
    return value;
  };
  const hosted = JSON.stringify(fallback);
  const repo = env.PICK_REPO ?? '';
  if (!env.PICK_TOKEN) return done(hosted, 'no token');
  // With PICK_ORG the runner is an org runner, which the repo's runner list does not show.
  const org = env.PICK_ORG ?? '';
  if (org ? !/^[A-Za-z0-9-]{1,39}$/.test(org) : !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return done(hosted, 'bad input');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(label)) return done(hosted, 'bad input');
  const path = org ? `orgs/${org}` : `repos/${repo}`;
  try {
    // shortcut: one page is enough for a handful of Macs, paginate past 100 runners.
    const res = await fetchFn(`${env.GITHUB_API_URL || 'https://api.github.com'}/${path}/actions/runners?per_page=100`, {
      headers: { Authorization: `Bearer ${env.PICK_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return done(hosted, `api ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.runners)) return done(hosted, 'api error');
    const value = pick(body.runners, label, fallback);
    return done(value, value === hosted ? 'no idle runner' : 'idle runner');
  } catch {
    return done(hosted, 'api error');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let value;
  try {
    value = await main();
  } catch {
    value = JSON.stringify(process.env.PICK_FALLBACK || 'macos-latest');
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `runs-on=${value}\n`);
  else console.log(`runs-on=${value}`);
}

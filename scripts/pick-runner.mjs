// Picks the runner for a job: the owner's idle Mac runner, else a GitHub-hosted one.
// Never fails the workflow: no token, an API error or a bad reply all give the fallback.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function pick(runners, label, fallback) {
  const idle = runners.some((r) => r.status === 'online' && r.busy === false && (r.labels ?? []).some((l) => l.name === label));
  return JSON.stringify(idle ? ['self-hosted', label] : fallback);
}

/**
 * Asks Nekko Cloud (decision 0064), proving the repository with the job's GitHub OIDC token
 * (`permissions: id-token: write`). The runs-on JSON, null for "none free, go hosted", or
 * undefined when Cloud could not answer, so the caller falls back to GitHub's runner list.
 */
export async function askCloud(env, fetchFn, label) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(env.PICK_CLOUD ?? '') || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return undefined;
  try {
    const id = await fetchFn(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=nekko-cloud`, {
      headers: { Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    const token = id.ok ? (await id.json())?.value : null;
    if (typeof token !== 'string') return undefined;
    const res = await fetchFn(`${env.PICK_CLOUD}/v1/runners/pick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, guest: env.PICK_GUEST === 'linux' ? 'linux' : 'macos' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return undefined;
    const runsOn = (await res.json())?.runsOn;
    if (runsOn === null) return null;
    const good = Array.isArray(runsOn) && runsOn.length === 2 && runsOn[0] === 'self-hosted' && typeof runsOn[1] === 'string' && runsOn[1].startsWith(label);
    return good ? JSON.stringify(runsOn) : undefined;
  } catch {
    return undefined;
  }
}

export async function main(env = process.env, fetchFn = globalThis.fetch) {
  const label = env.PICK_LABEL || 'nekko-cloud-mac';
  const fallback = env.PICK_FALLBACK || 'macos-latest';
  const done = (value, reason) => {
    console.error(`runs-on ${value}: ${reason}`);
    return value;
  };
  const hosted = JSON.stringify(fallback);
  if (/^[A-Za-z0-9._-]{1,64}$/.test(label)) {
    const cloud = await askCloud(env, fetchFn, label);
    if (cloud === null) return done(hosted, 'Nekko Cloud: no free Mac');
    if (cloud) return done(cloud, 'Nekko Cloud: a free Mac');
  }
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

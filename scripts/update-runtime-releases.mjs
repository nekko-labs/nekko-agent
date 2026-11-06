import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function usableRelease(runtime, release) {
  if (release.draft || !release.tag_name || !release.published_at || !(runtime === 'llama' ? /^b\d+$/ : /^master-\d+-[a-f0-9]{3,40}$/).test(release.tag_name)) return false;
  const names = (release.assets ?? []).filter(a => a.size > 0 && a.state === 'uploaded').map(a => a.name);
  if (runtime === 'llama') return names.some(n => /^llama-b\d+-bin-win-cpu-x64\.zip$/.test(n)) && names.some(n => /bin-macos-arm64\.tar\.gz$/.test(n)) && names.some(n => /bin-ubuntu-x64\.tar\.gz$/.test(n));
  return names.some(n => /^sd-.*-bin-win-cpu-x64\.zip$/.test(n)) && names.some(n => /^sd-.*-bin-Darwin-.*-arm64\.zip$/.test(n)) && names.some(n => /^sd-.*-bin-Linux-.*-x86_64\.zip$/.test(n));
}

export function chooseRelease(runtime, releases, now = Date.now()) {
  return releases.filter(r => usableRelease(runtime, r) && now - Date.parse(r.published_at) >= 7 * 86400_000).sort((a,b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}

export function shouldUpdate(runtime, current, candidate) {
  const pattern = runtime === 'llama' ? /^b(\d+)$/ : /^master-(\d+)-[a-f0-9]+$/;
  const before = current.match(pattern), after = candidate.match(pattern);
  return !!before && !!after && Number(after[1]) > Number(before[1]);
}

/** The tag `release_pin` gives `repo`: `("ggml-org/llama.cpp", "b11224")`. */
export function currentPin(source, repo) {
  const at = source.indexOf(`("${repo}", "`);
  if (at < 0) return undefined;
  const start = at + repo.length + 6;
  const end = source.indexOf('")', start);
  return end > start ? source.slice(start, end) : undefined;
}

function run() {
  const runtime = process.argv[2];
  if (!['llama', 'diffusion'].includes(runtime)) throw new Error('Expected llama or diffusion');
  const repo = runtime === 'llama' ? 'ggml-org/llama.cpp' : 'leejet/stable-diffusion.cpp';
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
  const git = (...args) => execFileSync('git', args, { encoding:'utf8' }).trim();
  const releases = [];
  for (let page = 1; page <= 4; page++) {
    const rows = JSON.parse(gh('api', `repos/${repo}/releases?per_page=100&page=${page}`, '--jq', '[.[] | {tag_name, draft, published_at, assets: [.assets[] | {name, state, size}]}]'));
    releases.push(...rows);
    if (chooseRelease(runtime, releases) || rows.length < 100) break;
  }
  const release = chooseRelease(runtime, releases);
  if (!release) { console.log('No eligible binary release.'); return; }
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ runtime, repo, tag: release.tag_name, assets: release.assets.length })); return; }
  const branch = `runtime-update/${runtime}`;
  // The pin (nekko-engine's `release_pin`), and the recorded installs and the
  // daemon test that name the same tag.
  const file = 'crates/nekko-engine/src/builds.rs';
  const alsoNamingIt = ['crates/nekko-engine/tests/golden/install.json', 'crates/nekkod/tests/daemon/engine.rs'];
  const repoName = process.env.GITHUB_REPOSITORY;
  const existing = JSON.parse(gh('pr', 'list', '--repo', repoName, '--head', branch, '--state', 'open', '--json', 'number'))[0];
  // Build on the branch only while its PR is open. Once that PR is squash-merged
  // the branch is a dead end: merging main into it conflicts with the squashed
  // copy of its own commits, so start over from main and replace it.
  if (existing && git('ls-remote', '--heads', 'origin', branch)) {
    git('fetch', 'origin', branch);
    git('switch', '--track', `origin/${branch}`);
    git('-c', 'user.name=runtime-update-bot', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'merge', 'origin/main', '--no-edit');
  } else git('switch', '-C', branch);
  const current = currentPin(readFileSync(file, 'utf8'), repo);
  if (!current) throw new Error('The runtime pin has an unexpected shape.');
  if (!shouldUpdate(runtime, current, release.tag_name)) { console.log('No newer eligible release.'); return; }
  for (const f of [file, ...alsoNamingIt]) writeFileSync(f, readFileSync(f, 'utf8').split(current).join(release.tag_name));
  git('add', file, ...alsoNamingIt);
  git('-c', 'user.name=runtime-update-bot', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `Update ${repo} to ${release.tag_name}`);
  git('push', ...(existing ? [] : ['--force']), 'origin', branch);
  if (!existing) gh('pr', 'create', '--repo', repoName, '--head', branch, '--base', 'main', '--title', `Update ${repo} to ${release.tag_name}`, '--body', `## Summary\nUpdate the recommended runtime to upstream ${release.tag_name}. Release assets exist for the supported baseline platforms and the release is at least seven days old.\n\n## Test plan\nRuntime matching tests, typecheck and build run through CI.\n\nNo visual change.`);
  if (existing) gh('pr', 'edit', String(existing.number), '--repo', repoName, '--title', `Update ${repo} to ${release.tag_name}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();

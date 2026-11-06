// The version a build carries: MAJOR.MINOR.BUILD (docs/decisions/0055).
//
// MAJOR.MINOR come from the newest release tag (`vMAJOR.MINOR` or
// `vMAJOR.MINOR.PATCH`, no suffix), which a person creates by hand: that is the
// only way to bump them. BUILD counts one platform's nightly builds since that
// tag. Each platform keeps its own counter as annotated git tags,
// `nightly/<platform>/vMAJOR.MINOR.BUILD`, on the commit that was built, so the
// count survives runners, re-runs and cache evictions and anyone can see which
// commit a build came from (`git tag -l 'nightly/ios/*'`).
//
// The store builds (Android versionCode, iOS CFBundleVersion) need one
// increasing integer: MAJOR*10000000 + MINOR*10000 + BUILD, which keeps
// MINOR to 0-999 and BUILD to 0-9999 and stays under Android's 2100000000 cap.
//
// Usage:
//   node scripts/nightly-version.mjs --platform ios              # dry run: print the next version
//   node scripts/nightly-version.mjs --platform ios --reserve    # create and push the counter tag
//   node scripts/nightly-version.mjs --platform desktop --reserve --reuse-same-commit
//   node scripts/nightly-version.mjs --release-tag v0.9          # prints v0.9.0
//
// --reuse-same-commit: when the commit being built already carries this
// platform's counter tag in the current line, use that version instead of a new
// one (a re-run, or a quiet night with no new commits). Never for iOS: App
// Store Connect refuses a build number it has already seen.
//
// With GITHUB_OUTPUT set, writes version, code, tag and reused there too.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PLATFORMS = ['desktop', 'ios', 'android'];
export const MAX_MINOR = 999;
export const MAX_BUILD = 9999;
// Google Play's versionCode ceiling; iOS takes any 32-bit value.
export const MAX_CODE = 2_100_000_000;

/** `v0.9`, `v0.9.0`, `v0.8.2` -> numbers; anything else (a suffix, another prefix) -> null. */
export function parseReleaseTag(name) {
  const m = /^v(\d+)\.(\d+)(?:\.(\d+))?$/.exec(name);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] === undefined ? null : Number(m[3]) };
}

/** The tag release.yml builds from a manual bump: `v0.9` -> `v0.9.0`; a full tag is unchanged. */
export function canonicalReleaseTag(name) {
  const r = parseReleaseTag(name);
  if (!r) throw new Error(`${name} is not a release tag (vMAJOR.MINOR or vMAJOR.MINOR.PATCH).`);
  return `v${r.major}.${r.minor}.${r.patch ?? 0}`;
}

/** `nightly/ios/v0.9.12` -> { platform, major, minor, build }, else null. */
export function parseNightlyTag(name) {
  const m = /^nightly\/([a-z]+)\/v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!m) return null;
  return { platform: m[1], major: Number(m[2]), minor: Number(m[3]), build: Number(m[4]) };
}

const cmpLine = (a, b) => a.major - b.major || a.minor - b.minor;

/** The newest MAJOR.MINOR any release tag names. */
export function currentLine(tags) {
  let best = null;
  for (const t of tags) {
    const r = parseReleaseTag(t);
    if (r && (!best || cmpLine(r, best) > 0)) best = { major: r.major, minor: r.minor };
  }
  if (!best) throw new Error('No release tag (vMAJOR.MINOR[.PATCH]) found; fetch tags first (actions/checkout fetch-depth: 0).');
  return best;
}

export function storeCode({ major, minor, build }) {
  if (minor > MAX_MINOR) throw new Error(`MINOR ${minor} is over ${MAX_MINOR}: bump MAJOR.`);
  if (build > MAX_BUILD) throw new Error(`BUILD ${build} is over ${MAX_BUILD}: tag a new MAJOR.MINOR.`);
  const code = major * 10_000_000 + minor * 10_000 + build;
  if (code > MAX_CODE) throw new Error(`Store code ${code} is over ${MAX_CODE}.`);
  return code;
}

/**
 * The version a build of `platform` gets.
 * tags: every tag name; tagsAtCommit: the names on the commit being built.
 * Desktop shares its number space with the releases (installers, npm), so its
 * BUILD also starts above any release tag's PATCH in the line: a nightly never
 * reuses a released number (v0.8.2 shipped, so the first 0.8 nightly is 0.8.3).
 */
export function planVersion({ tags, platform, tagsAtCommit = [], reuseSameCommit = false }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform ${platform}; one of ${PLATFORMS.join(', ')}.`);
  const line = currentLine(tags);
  const inLine = n => n && n.platform === platform && n.major === line.major && n.minor === line.minor;
  if (reuseSameCommit) {
    const here = tagsAtCommit.map(parseNightlyTag).filter(inLine).sort((a, b) => b.build - a.build)[0];
    if (here) return finish(platform, { ...line, build: here.build }, true);
  }
  let last = 0;
  for (const t of tags) {
    const n = parseNightlyTag(t);
    if (inLine(n)) last = Math.max(last, n.build);
    if (platform === 'desktop') {
      const r = parseReleaseTag(t);
      if (r && r.patch !== null && r.major === line.major && r.minor === line.minor) last = Math.max(last, r.patch);
    }
  }
  return finish(platform, { ...line, build: last + 1 }, false);
}

function finish(platform, v, reused) {
  const version = `${v.major}.${v.minor}.${v.build}`;
  return { platform, version, code: storeCode(v), tag: `nightly/${platform}/v${version}`, reused };
}

// ---- git side -------------------------------------------------------------

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lines = s => (s ? s.split('\n').filter(Boolean) : []);

function readTags(sha) {
  return { tags: lines(git('tag', '-l')), tagsAtCommit: lines(git('tag', '--points-at', sha)) };
}

/** Plans, then (with reserve) pushes the counter tag; a lost race re-plans. */
export function run({ platform, reserve, reuseSameCommit, sha = 'HEAD', attempts = 5, log = console.error, beforePush = () => {} }) {
  const commit = git('rev-parse', `${sha}^{commit}`);
  for (let i = 1; ; i++) {
    if (reserve) git('fetch', '--quiet', '--force', 'origin', '+refs/tags/*:refs/tags/*');
    const plan = planVersion({ platform, reuseSameCommit, ...readTags(commit) });
    if (!reserve || plan.reused) return { ...plan, commit };
    // A runner has no identity configured, and an annotated tag needs a tagger.
    let who = [];
    try { git('config', 'user.email'); } catch { who = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=github-actions[bot]@users.noreply.github.com']; }
    // The nonce matters: two runs tagging the same commit in the same second
    // would otherwise make byte-identical tag objects, and the second push would
    // "succeed" as a no-op, handing both the same number.
    const by = process.env.GITHUB_RUN_ID ? `run ${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT ?? 1}` : 'local';
    git(...who, 'tag', '-a', plan.tag, '-m', `${platform} nightly ${plan.version} (store code ${plan.code})`, '-m', `${by} ${randomUUID()}`, commit);
    try {
      beforePush(plan); // tests use this to lose a race on purpose
      git('push', '--quiet', 'origin', `refs/tags/${plan.tag}`);
      return { ...plan, commit };
    } catch (err) {
      git('tag', '-d', plan.tag);
      if (i >= attempts) throw new Error(`Could not push ${plan.tag} after ${attempts} tries: ${err.stderr || err.message}`);
      log(`${plan.tag} was taken (another run got there first); trying the next number.`);
    }
  }
}

function parseArgs(argv) {
  const o = { reserve: false, reuseSameCommit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform') o.platform = argv[++i];
    else if (a === '--sha') o.sha = argv[++i];
    else if (a === '--release-tag') o.releaseTag = argv[++i];
    else if (a === '--reserve') o.reserve = true;
    else if (a === '--dry-run') o.reserve = false;
    else if (a === '--reuse-same-commit') o.reuseSameCommit = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return o;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.releaseTag) {
      console.log(canonicalReleaseTag(o.releaseTag));
    } else {
      if (o.platform === 'ios' && o.reuseSameCommit) throw new Error('iOS never reuses a build number: App Store Connect rejects it.');
      const r = run(o);
      const what = r.reused ? 'already built as' : o.reserve ? 'reserved' : 'dry run, would reserve';
      console.error(`${r.platform}: ${what} ${r.version} (store code ${r.code}, tag ${r.tag}) at ${r.commit.slice(0, 7)}`);
      console.log(JSON.stringify(r));
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `version=${r.version}\ncode=${r.code}\ntag=${r.tag}\nreused=${r.reused}\n`);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

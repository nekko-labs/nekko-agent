// Decides which of ci.yml's slow jobs a run needs. Three tiers:
//
// - pull_request (fast tier): `build`, plus the daemon on Linux and capture on
//   Windows when the PR touches what they test. Feedback in about 8 minutes.
//   The `ci:macos` / `ci:perf` labels opt a PR into those jobs (labels are read
//   when a run starts; adding one re-runs CI).
// - merge_group (queue tier): what must hold before anything reaches main. Adds
//   the Windows daemon and the speed contract, path-gated like the PR tier. A
//   group's file list is its diff against main, so a skipped job is one that no
//   PR in the group could affect.
// - schedule, push to main, workflow_dispatch (full tier): every job on every
//   OS, macOS included. GitHub's Team plan runs 5 macOS jobs at once across all
//   workflows, so macOS runs every 6 hours (and before nightly releases), not
//   per change.
//
// Unknown changed files (none listed, or a list at the API's 3,000-file cap) and
// changes to CI itself fall back to every job of the tier.
//
// `itests`, the loopback end-to-end scripts (Local Web UI + nekkod + scripted
// models), never run on a pull request, and `gate` does not wait for them, so
// they report without holding a PR or the queue. They run on what lands on
// main: every merge-queue group (ci.yml has no `push` trigger; the queue's
// group is the commit main moves to), the 6-hourly schedule and a dispatch.

const RUST = [/^crates\//, /^Cargo\.(toml|lock)$/, /^rust-toolchain\.toml$/, /^rustfmt\.toml$/];
// Shared's contracts feed the engine's golden sets (the phone allowlist, the IPC names).
const DAEMON = [...RUST, /^packages\/shared\//];
// Capture is also the job that builds the native browser (and fails on its warnings).
const CAPTURE = [/^apps\/desktop\//, /^packages\//, /^vendor\/agent-browser\//, /^scripts\/build-agent-browser\.mjs$/];
// The speed contract measures the Local Web UI: renderer, engine, server, daemon.
const PERF = [/^scripts\/perf\//, /^apps\/desktop\/src\/renderer\//, /^apps\/local-web-ui\//, /^packages\//, ...RUST];
// The native phone apps: their own workflows (ios-native.yml, android-native.yml)
// build and test them, and nothing in `build` reads them. A change only here
// skips `build` (npm and the cargo build of nekkod) and the queue's itests.
const NATIVE_APPS = [/^apps\/ios\//, /^apps\/android\//];
// CodeQL's languages, by the files that hold them.
const CODEQL = {
  actions: [/^\.github\/(workflows|actions)\//],
  'javascript-typescript': [/\.[cm]?[jt]sx?$/, /\.vue$/, /\.html?$/],
  python: [/\.py$/],
  rust: [/\.rs$/, /(^|\/)Cargo\.(toml|lock)$/],
  swift: [/\.swift$/, /(^|\/)Package\.resolved$/],
};
// Changes here can affect any job.
const EVERYTHING = [/^\.github\/workflows\/(ci|codeql)\.yml$/, /^scripts\/ci-scope\.mjs$/, /^package(-lock)?\.json$/];

export const FILE_LIST_CAP = 3000;
const FULL = new Set(['schedule', 'push', 'workflow_dispatch']);

const touches = (files, patterns) => files.some(file => patterns.some(pattern => pattern.test(file)));

export function ciScope({ event, files = [], labels = [] }) {
  if (FULL.has(event)) {
    return { build: true, daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: true, itests: true };
  }
  const queue = event === 'merge_group';
  const all = files.length === 0 || files.length >= FILE_LIST_CAP || touches(files, EVERYTHING);
  // `ci:macos` adds the macOS row to a job the change already needs, never to one it doesn't.
  const macos = labels.includes('ci:macos');
  const build = all || !files.every(file => NATIVE_APPS.some(pattern => pattern.test(file)));
  const daemon = all || touches(files, DAEMON);
  const capture = all || touches(files, CAPTURE);
  const perf = labels.includes('ci:perf') || (queue && (all || touches(files, PERF)));
  return {
    build,
    daemon_os: [...(daemon ? ['ubuntu-latest'] : []), ...(daemon && queue ? ['windows-latest'] : []), ...(daemon && macos ? ['macos-latest'] : [])],
    capture_os: [...(capture ? ['windows-latest'] : []), ...(capture && macos ? ['macos-latest'] : [])],
    perf,
    itests: queue && build,
  };
}

/**
 * The languages codeql.yml analyses. The schedule and a dispatch take all five.
 * A PR or queue group takes the ones its files are in (every Linux one when the
 * list is unknown or CI changed); Swift needs a macOS runner, so a PR takes it
 * only with `ci:macos` and the queue never does.
 */
export function codeqlLanguages({ event, files = [], labels = [] }) {
  if (FULL.has(event)) return Object.keys(CODEQL);
  const all = files.length === 0 || files.length >= FILE_LIST_CAP || touches(files, EVERYTHING);
  const swift = event === 'pull_request' && labels.includes('ci:macos');
  const changed = lang => all || touches(files, CODEQL[lang]);
  return Object.keys(CODEQL).filter(lang => changed(lang) && (lang !== 'swift' || swift));
}

const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, appendFileSync } = await import('node:fs');
  const files = process.env.CI_CHANGED_FILES ? readFileSync(process.env.CI_CHANGED_FILES, 'utf8').split('\n').filter(Boolean) : [];
  const labels = JSON.parse(process.env.CI_LABELS || '[]') || [];
  const scope = ciScope({ event: process.env.GITHUB_EVENT_NAME, files, labels });
  const codeql = codeqlLanguages({ event: process.env.GITHUB_EVENT_NAME, files, labels });
  const lines = [`build=${scope.build}`, `daemon_os=${JSON.stringify(scope.daemon_os)}`, `capture_os=${JSON.stringify(scope.capture_os)}`, `perf=${scope.perf}`, `itests=${scope.itests}`, `codeql=${JSON.stringify(codeql)}`];
  console.log(`${process.env.GITHUB_EVENT_NAME}: ${files.length} changed file(s), labels ${JSON.stringify(labels)}\n${lines.join('\n')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

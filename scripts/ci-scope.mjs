// Decides which of ci.yml's slow jobs a run needs. Two tiers:
//
// - pull_request: `build`, gated by the paths the PR touches; the speed
//   contract (`perf`) when the PR changes what it measures (`ci:perf` forces
//   it); and `itests`, the loopback end-to-end scripts (Local Web UI + nekkod +
//   scripted models), whenever the PR needs `build`. `gate` waits for both. The
//   per-OS jobs (the daemon, capture) run on a PR only with a `deploy:<os>`
//   label (`deploy:linux`, `deploy:windows`, `deploy:macos`), and only when the
//   change touches what they test. Labels are read when a run starts; adding
//   one re-runs CI.
// - schedule, push to main, workflow_dispatch (full tier): every job on every
//   OS, macOS included, plus the speed contract and itests. The schedule is
//   nightly: platform builds run once a day, not per change, unless a
//   `deploy:<platform>` label asks.
//
// There is no merge queue (removed 2026-11-06), so nothing runs between a PR's
// `gate` and main: the PR is the last place to stop a speed or itest
// regression (decision 0059, superseding 0056's nightly-only runs).
//
// Unknown changed files (none listed, or a list at the API's 3,000-file cap) and
// changes to CI itself fall back to every job of the tier.

const RUST = [/^crates\//, /^Cargo\.(toml|lock)$/, /^rust-toolchain\.toml$/, /^rustfmt\.toml$/];
// Shared's contracts feed the engine's golden sets (the phone allowlist, the IPC names).
const DAEMON = [...RUST, /^packages\/shared\//];
// Capture is also the job that builds the native browser (and fails on its warnings).
const CAPTURE = [/^apps\/desktop\//, /^packages\//, /^vendor\/agent-browser\//, /^scripts\/build-agent-browser\.mjs$/];
// The speed contract measures the Local Web UI: renderer, engine, server, daemon.
const PERF = [/^scripts\/perf\//, /^apps\/desktop\/src\/renderer\//, /^apps\/local-web-ui\//, /^packages\//, ...RUST];
// The native phone apps: their own workflows (ios-native.yml, android-native.yml)
// build and test them, and nothing in `build` reads them. A change only here
// skips `build` (npm and the cargo build of nekkod) and the itests.
const NATIVE_APPS = [/^apps\/ios\//, /^apps\/android\//];
// CodeQL's languages, by the files that hold them.
const CODEQL = {
  actions: [/^\.github\/(workflows|actions)\//],
  'javascript-typescript': [/\.[cm]?[jt]sx?$/, /\.vue$/, /\.html?$/],
  python: [/\.py$/],
  rust: [/\.rs$/, /(^|\/)Cargo\.(toml|lock)$/],
  swift: [/\.swift$/, /(^|\/)Package\.resolved$/],
};
// What the license policy reads (scripts/third-party.mjs).
const LICENSES = [/(^|\/)package(-lock)?\.json$/, /(^|\/)Cargo\.(toml|lock)$/, /^ASSETS\.md$/, /^scripts\/third-party\.mjs$/, /^scripts\/license-policy\.json$/];
// Changes here can affect any job.
const EVERYTHING = [/^\.github\/workflows\/(ci|codeql)\.yml$/, /^scripts\/ci-scope\.mjs$/, /^package(-lock)?\.json$/];

export const FILE_LIST_CAP = 3000;
const FULL = new Set(['schedule', 'push', 'workflow_dispatch']);

const touches = (files, patterns) => files.some(file => patterns.some(pattern => pattern.test(file)));

export function ciScope({ event, files = [], labels = [] }) {
  if (FULL.has(event)) {
    return { build: true, daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: true, itests: true, licenses: false };
  }
  const all = files.length === 0 || files.length >= FILE_LIST_CAP || touches(files, EVERYTHING);
  // A `deploy:<os>` label adds that OS's row to a job the change already needs, never to one it doesn't.
  const os = name => labels.includes(`deploy:${name}`);
  const build = all || !files.every(file => NATIVE_APPS.some(pattern => pattern.test(file)));
  const daemon = all || touches(files, DAEMON);
  const capture = all || touches(files, CAPTURE);
  return {
    build,
    daemon_os: [...(daemon && os('linux') ? ['ubuntu-latest'] : []), ...(daemon && os('windows') ? ['windows-latest'] : []), ...(daemon && os('macos') ? ['macos-latest'] : [])],
    capture_os: [...(capture && os('windows') ? ['windows-latest'] : []), ...(capture && os('macos') ? ['macos-latest'] : [])],
    perf: labels.includes('ci:perf') || all || touches(files, PERF),
    itests: build,
    licenses: all || touches(files, LICENSES),
  };
}

/**
 * The languages codeql.yml analyses. The schedule and a dispatch take all five.
 * A PR takes the ones its files are in (every Linux one when the list is
 * unknown or CI changed). Swift needs a macOS runner, and the Team plan's 5
 * macOS runners are the CI's bottleneck, so a PR never takes it: the nightly
 * schedule analyses Swift on main.
 */
export function codeqlLanguages({ event, files = [] }) {
  if (FULL.has(event)) return Object.keys(CODEQL);
  const all = files.length === 0 || files.length >= FILE_LIST_CAP || touches(files, EVERYTHING);
  const changed = lang => all || touches(files, CODEQL[lang]);
  return Object.keys(CODEQL).filter(lang => lang !== 'swift' && changed(lang));
}

const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, appendFileSync } = await import('node:fs');
  const files = process.env.CI_CHANGED_FILES ? readFileSync(process.env.CI_CHANGED_FILES, 'utf8').split('\n').filter(Boolean) : [];
  const labels = JSON.parse(process.env.CI_LABELS || '[]') || [];
  const scope = ciScope({ event: process.env.GITHUB_EVENT_NAME, files, labels });
  const codeql = codeqlLanguages({ event: process.env.GITHUB_EVENT_NAME, files, labels });
  const lines = [`build=${scope.build}`, `daemon_os=${JSON.stringify(scope.daemon_os)}`, `capture_os=${JSON.stringify(scope.capture_os)}`, `perf=${scope.perf}`, `itests=${scope.itests}`, `licenses=${scope.licenses}`, `codeql=${JSON.stringify(codeql)}`];
  console.log(`${process.env.GITHUB_EVENT_NAME}: ${files.length} changed file(s), labels ${JSON.stringify(labels)}\n${lines.join('\n')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

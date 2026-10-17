// Decides which of ci.yml's slow jobs a run needs. Three tiers:
//
// - pull_request (fast tier): `build`, plus the daemon on Linux and capture on
//   Windows when the PR touches what they test. Feedback in about 8 minutes.
//   The `ci:macos` / `ci:perf` labels opt a PR into those jobs (labels are read
//   when a run starts: add the label, then push or dispatch).
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

const RUST = [/^crates\//, /^Cargo\.(toml|lock)$/, /^rust-toolchain\.toml$/, /^rustfmt\.toml$/];
// The daemon job also runs the host's session-clear parity tests against nekkod.
const DAEMON = [...RUST, /^packages\/(host|core|shared)\//];
const CAPTURE = [/^apps\/desktop\//, /^packages\//];
// The speed contract measures the web edition: renderer, engine, server, daemon.
const PERF = [/^scripts\/perf\//, /^apps\/desktop\/src\/renderer\//, /^apps\/web-app-server\//, /^packages\//, ...RUST];
// Changes here can affect any job.
const EVERYTHING = [/^\.github\/workflows\/ci\.yml$/, /^scripts\/ci-scope\.mjs$/, /^package(-lock)?\.json$/];

export const FILE_LIST_CAP = 3000;
const FULL = new Set(['schedule', 'push', 'workflow_dispatch']);

const touches = (files, patterns) => files.some(file => patterns.some(pattern => pattern.test(file)));

export function ciScope({ event, files = [], labels = [] }) {
  if (FULL.has(event)) {
    return { daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: true };
  }
  const queue = event === 'merge_group';
  const all = files.length === 0 || files.length >= FILE_LIST_CAP || touches(files, EVERYTHING);
  const macos = labels.includes('ci:macos');
  const daemon = all || touches(files, DAEMON);
  const capture = all || touches(files, CAPTURE);
  const perf = labels.includes('ci:perf') || (queue && (all || touches(files, PERF)));
  return {
    daemon_os: [...(daemon ? ['ubuntu-latest'] : []), ...(daemon && queue ? ['windows-latest'] : []), ...(macos ? ['macos-latest'] : [])],
    capture_os: [...(capture ? ['windows-latest'] : []), ...(macos ? ['macos-latest'] : [])],
    perf,
  };
}

const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, appendFileSync } = await import('node:fs');
  const files = process.env.CI_CHANGED_FILES ? readFileSync(process.env.CI_CHANGED_FILES, 'utf8').split('\n').filter(Boolean) : [];
  const labels = JSON.parse(process.env.CI_LABELS || '[]') || [];
  const scope = ciScope({ event: process.env.GITHUB_EVENT_NAME, files, labels });
  const lines = [`daemon_os=${JSON.stringify(scope.daemon_os)}`, `capture_os=${JSON.stringify(scope.capture_os)}`, `perf=${scope.perf}`];
  console.log(`${process.env.GITHUB_EVENT_NAME}: ${files.length} changed file(s), labels ${JSON.stringify(labels)}\n${lines.join('\n')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

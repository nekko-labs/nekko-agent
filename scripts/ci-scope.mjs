// Decides which of ci.yml's slow jobs a run needs, so a PR only waits for the
// checks its changes can affect. `build` (the required check) always runs and is
// not decided here.
//
// - push to main and workflow_dispatch: everything, on every platform. Main is
//   where the scarce macOS runners (5 concurrent on the Team plan, shared by all
//   workflows) and the noisy speed contract are spent by default.
// - pull_request: Linux and Windows jobs gated by the paths they test. macOS jobs
//   and `perf` run only with the `ci:macos` / `ci:perf` labels (labels are read when
//   a run starts: add the label, then push, or dispatch CI on the branch).
// - Unknown changed files (none listed, or a list at the API's 3,000-file cap)
//   fall back to the full set rather than skipping anything.

const RUST = [/^crates\//, /^Cargo\.(toml|lock)$/, /^rust-toolchain\.toml$/, /^rustfmt\.toml$/];
// The daemon job also runs the host's session-clear parity tests against nekkod.
const DAEMON = [...RUST, /^packages\/(host|core|shared)\//];
const CAPTURE = [/^apps\/desktop\//, /^packages\//];
const PERF = [/^scripts\/perf\//];
// Changes here can affect any job.
const EVERYTHING = [/^\.github\/workflows\/ci\.yml$/, /^scripts\/ci-scope\.mjs$/, /^package(-lock)?\.json$/];

export const FILE_LIST_CAP = 3000;

const touches = (files, patterns) => files.some(file => patterns.some(pattern => pattern.test(file)));

export function ciScope({ event, files = [], labels = [] }) {
  const all = event !== 'pull_request' || files.length === 0 || files.length >= FILE_LIST_CAP || touches(files, EVERYTHING);
  const macos = event !== 'pull_request' || labels.includes('ci:macos');
  const daemon = all || touches(files, DAEMON);
  const capture = all || touches(files, CAPTURE);
  const perf = event !== 'pull_request' || labels.includes('ci:perf') || touches(files, PERF);
  return {
    daemon_os: [...(daemon ? ['ubuntu-latest', 'windows-latest'] : []), ...(macos ? ['macos-latest'] : [])],
    capture_os: [...(capture ? ['windows-latest'] : []), ...(macos ? ['macos-latest'] : [])],
    perf,
  };
}

const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, appendFileSync } = await import('node:fs');
  const files = process.env.CI_CHANGED_FILES ? readFileSync(process.env.CI_CHANGED_FILES, 'utf8').split('\n').filter(Boolean) : [];
  const labels = JSON.parse(process.env.CI_LABELS || '[]');
  const scope = ciScope({ event: process.env.GITHUB_EVENT_NAME, files, labels });
  const lines = [`daemon_os=${JSON.stringify(scope.daemon_os)}`, `capture_os=${JSON.stringify(scope.capture_os)}`, `perf=${scope.perf}`];
  console.log(`${files.length} changed file(s), labels ${JSON.stringify(labels)}\n${lines.join('\n')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

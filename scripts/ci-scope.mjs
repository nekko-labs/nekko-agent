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
// `ios`, Native iOS (ios-native.yml, called from ci.yml), runs only in the
// queue, for an entry whose own PR touches the iOS app or what its live tests
// drive. Each queue entry is built on top of the ones ahead of it, so one run
// covers that PR plus everything queued before it; a PR runs it only on
// demand (the `ci:macos` label, or a dispatch), not on every push. Its own
// files are the entry's head commit (the queue squashes each PR into one);
// unknown, the group's files stand in.
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
// What Native iOS builds or its live tests drive (ios-native.yml's PR paths).
const IOS = [/^apps\/ios\//, /^apps\/relay-server\/src\//, /^crates\/nekko-remote\//, /^crates\/nekkod\/src\/remote\.rs$/,
  /^packages\/shared\/src\/(phone-access|pairing-link)\.ts$/, /^\.github\/workflows\/ios-native\.yml$/, /^scripts\/ios-theme-scope\.mjs$/];
// Changes here can affect any job.
const EVERYTHING = [/^\.github\/workflows\/ci\.yml$/, /^scripts\/ci-scope\.mjs$/, /^package(-lock)?\.json$/];

export const FILE_LIST_CAP = 3000;
const FULL = new Set(['schedule', 'push', 'workflow_dispatch']);

const touches = (files, patterns) => files.some(file => patterns.some(pattern => pattern.test(file)));

export function ciScope({ event, files = [], labels = [], ownFiles = [] }) {
  // Native iOS keeps its own 6-hourly schedule; the full tier does not repeat it.
  if (FULL.has(event)) {
    return { daemon_os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], capture_os: ['windows-latest', 'macos-latest'], perf: true, itests: true, ios: false };
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
    itests: queue,
    ios: queue && touches(ownFiles.length ? ownFiles : files, IOS),
  };
}

const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, appendFileSync } = await import('node:fs');
  const list = path => (path ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
  const files = list(process.env.CI_CHANGED_FILES);
  const ownFiles = list(process.env.CI_OWN_FILES);
  const labels = JSON.parse(process.env.CI_LABELS || '[]') || [];
  const scope = ciScope({ event: process.env.GITHUB_EVENT_NAME, files, labels, ownFiles });
  const lines = [`daemon_os=${JSON.stringify(scope.daemon_os)}`, `capture_os=${JSON.stringify(scope.capture_os)}`, `perf=${scope.perf}`, `itests=${scope.itests}`, `ios=${scope.ios}`];
  console.log(`${process.env.GITHUB_EVENT_NAME}: ${files.length} changed file(s), labels ${JSON.stringify(labels)}\n${lines.join('\n')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

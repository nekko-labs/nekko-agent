// Third-party licensing, one tool for two jobs:
//
//   node scripts/third-party.mjs check     every npm package, crate and ASSETS.md row
//                                          against scripts/license-policy.json. CI runs
//                                          this when dependencies change.
//   node scripts/third-party.mjs notices   writes THIRD_PARTY_NOTICES.txt into the built
//                                          renderer. `dist` and `release` run it after
//                                          electron-vite build, so it ships in the app.
//
// Packaging generates the file rather than git holding it: dependency PRs would
// conflict on it, and it needs every crate's source on disk, which most builds skip.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;
const ASSET_COLUMNS = ['Name', 'Used for', 'Version', 'License', 'License file', 'Source'];

/** Does an SPDX expression hold under the allow list? `OR` needs one side, `AND` both. */
export function licenseAllowed(expression, allow) {
  let s = expression
    .replace(/\s*\/\s*/g, ' OR ') // the old Cargo spelling, "MIT/Apache-2.0"
    .replace(/[\w.+-]+( WITH [\w.+-]+)?/g, (id) => (id === 'AND' || id === 'OR' ? id : allow.includes(id) ? '1' : '0'));
  const collapse = (pattern, join) => s.replace(pattern, (_, a, b) => (join(a === '1', b === '1') ? '1' : '0'));
  for (;;) {
    const before = s;
    s = s.replace(/\(([01])\)/g, '$1');
    s = collapse(/([01]) AND ([01])/, (a, b) => a && b);
    if (s === before) s = collapse(/([01]) OR ([01])/, (a, b) => a || b);
    if (s === before) return s === '1';
  }
}

/** Every package in the lockfile, dev tools included, as { name, version, license, dir, dev, platform }. */
export function npmPackages(root = repo) {
  const { packages } = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  return Object.entries(packages)
    .filter(([dir, pkg]) => dir.includes('node_modules/') && !pkg.link)
    .map(([dir, pkg]) => ({
      name: dir.slice(dir.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: pkg.version,
      license: typeof pkg.license === 'string' ? pkg.license : null,
      dir,
      dev: !!pkg.dev,
      platform: !!(pkg.os || pkg.cpu),
    }));
}

/** Every crate from a registry or git source. `cargo metadata` downloads what is missing. */
export function crates(root = repo) {
  const out = execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out).packages
    .filter((pkg) => pkg.source)
    .map((pkg) => ({ name: pkg.name, version: pkg.version, license: pkg.license ?? null, dir: dirname(pkg.manifest_path) }));
}

/** The rows of the table in ASSETS.md, as objects keyed by its column names. */
export function parseAssets(markdown) {
  const rows = markdown.split(/\r?\n/).filter((line) => line.startsWith('|'))
    .map((line) => line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim()));
  const [header, , ...body] = rows;
  return (body ?? []).map((cells) => Object.fromEntries(header.map((column, i) => [column, cells[i] ?? ''])));
}

/** What breaks the policy, as one readable line each. An empty list is a pass. */
export function findProblems({ packages, crates: crateList, assets, policy, fileExists }) {
  const problems = [];
  const judge = (kind, name, version, license) => {
    if (policy.exceptions[name]) return;
    if (!license) problems.push(`${kind} ${name}@${version} declares no license.`);
    else if (!licenseAllowed(license, policy.allow)) problems.push(`${kind} ${name}@${version} is ${license}, which is not on the allow list.`);
  };
  for (const pkg of packages) judge('npm', pkg.name, pkg.version, pkg.license);
  for (const crate of crateList) judge('crate', crate.name, crate.version, crate.license);
  for (const asset of assets) {
    for (const column of ASSET_COLUMNS) if (!asset[column]) problems.push(`ASSETS.md row "${asset.Name}" has no ${column}.`);
    judge('asset', asset.Name, asset.Version, asset.License);
    const file = asset['License file'];
    if (file && file !== '-' && !fileExists(file)) problems.push(`ASSETS.md row "${asset.Name}" points at ${file}, which does not exist.`);
  }
  return problems;
}

function readAssets(root) {
  return parseAssets(readFileSync(join(root, 'ASSETS.md'), 'utf8'));
}

function licenseText(dir) {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file) && statSync(join(dir, file)).isFile())
    .sort()
    .map((file) => readFileSync(join(dir, file), 'utf8').trim())
    .join('\n\n');
}

/** Packages the bundler pulled into the app, which `dev` flags in the lockfile miss (React, for one). */
function bundledDirs(root) {
  const out = join(root, 'apps', 'desktop', 'out');
  if (!existsSync(out)) return new Set();
  return new Set(readdirSync(out).filter((file) => file.startsWith('bundled-packages-'))
    .flatMap((file) => JSON.parse(readFileSync(join(out, file), 'utf8'))));
}

/** The notices file: one block per distinct license text, naming everything under it. */
export function buildNotices({ packages, crates: crateList, assets, bundled, root, crateNote }) {
  const groups = new Map();
  const add = (label, license, text) => {
    const body = text || `${license ?? 'See the project'} (no license file in the published package).`;
    if (!groups.has(body)) groups.set(body, []);
    groups.get(body).push(label);
  };
  for (const pkg of packages) {
    // Other platforms' binaries are not installed here, and a build only ships its own.
    if (pkg.platform && !existsSync(join(root, pkg.dir))) continue;
    if (pkg.dev && !bundled.has(pkg.dir) && pkg.name !== 'electron') continue;
    add(`${pkg.name} ${pkg.version} (${pkg.license ?? 'see below'})`, pkg.license, licenseText(join(root, pkg.dir)));
  }
  for (const crate of crateList) add(`${crate.name} ${crate.version} (${crate.license ?? 'see below'})`, crate.license, licenseText(crate.dir));
  for (const asset of assets) {
    const file = asset['License file'];
    if (file === '-') continue; // Covered by a package above, or fetched with its own notice.
    add(`${asset.Name} ${asset.Version} (${asset.License})`, asset.License, readFileSync(join(root, file), 'utf8').trim());
  }
  const blocks = [...groups].map(([text, labels]) => `${'='.repeat(78)}\n${labels.sort().join('\n')}\n${'-'.repeat(78)}\n${text}\n`);
  return [
    'Nekko Agent third-party notices',
    '',
    'Nekko Agent is MIT licensed. It is built with the software below, each under its own license.',
    'Credits: https://nekkoagent.com/docs/credits',
    ...(crateNote ? ['', crateNote] : []),
    '',
    ...blocks,
  ].join('\n');
}

export function main(argv, root = repo) {
  const [command, ...flags] = argv;
  const policy = JSON.parse(readFileSync(join(root, 'scripts', 'license-policy.json'), 'utf8'));
  if (command === 'check') {
    const problems = findProblems({
      packages: npmPackages(root), crates: crates(root), assets: readAssets(root), policy,
      fileExists: (file) => existsSync(join(root, file)),
    });
    if (problems.length) {
      console.error(`${problems.join('\n')}\n\n${problems.length} license problem(s). Replace the dependency, or see docs/runbooks/third-party.md.`);
      return 1;
    }
    console.log('Every dependency and asset is within the license policy.');
    return 0;
  }
  if (command === 'notices') {
    // shortcut: the Docker builder stage has no cargo, so its file lists npm packages only. Upgrade by building the notices in the nekkod stage.
    const skipCrates = flags.includes('--no-crates');
    const text = buildNotices({
      packages: npmPackages(root), crates: skipCrates ? [] : crates(root), assets: readAssets(root),
      bundled: bundledDirs(root), root,
      crateNote: skipCrates ? 'Rust crate notices are not listed in this build.' : '',
    });
    const file = join(root, 'apps', 'desktop', 'out', 'renderer', 'THIRD_PARTY_NOTICES.txt');
    writeFileSync(file, text);
    console.log(`Wrote ${file} (${Math.round(text.length / 1024)} KB).`);
    return 0;
  }
  console.error('Usage: node scripts/third-party.mjs check | notices [--no-crates]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

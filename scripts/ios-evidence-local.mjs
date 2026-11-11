#!/usr/bin/env node
// Matched before/after iPhone evidence on this Mac, instead of on CI's macOS runners.
//
// The Team plan gives the whole org 5 macOS runners, and evidence and diagnostic
// runs took about a third of their time in November 2026, queueing the Native iOS
// runs that `gate` waits for. This runs the same steps as the evidence workflows
// (native-mode-evidence.yml, ios-group-evidence.yml,
// ios-computer-settings-evidence.yml) on a Mac with Xcode:
//
//   1. a detached worktree per revision (baseline = before, source = after),
//   2. the harness files copied in from the harness commit (default: source),
//   3. xcodegen, then a fresh simulator this script creates, owns and deletes,
//   4. build-for-testing and test-without-building with -only-testing,
//   5. the xcresult's attachments exported to .shots/ios-evidence/<label>/<revision>/.
//
// The simulator boots headless (Simulator.app is never opened), so nothing appears
// on the desktop and the user's own simulators and app data are untouched.
//
//   node scripts/ios-evidence-local.mjs --preset mode --baseline <sha> --source <sha> \
//     --test-file apps/ios/UITests/ThemeLanguageTests.swift \
//     --only-testing NekkoNativeUITests/ThemeLanguageTests/testSimpleModeLabelEvidence
//   node scripts/ios-evidence-local.mjs --preset groups --baseline <sha> --source <sha>
//   node scripts/ios-evidence-local.mjs --preset computer-settings --baseline <sha> --source <sha>
//
// Flags: --label <name> (output folder, default the preset), --harness <sha>,
// --runtime <simulator runtime id> (default iOS 27.0, what CI pins), --only before|after,
// --keep (leave the worktrees for inspection). See docs/runbooks/visual-evidence.md.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
export const DEVICE_TYPE = /iPhone-\d+-Pro$/;
const SHA = /^[0-9a-f]{40}$/;

// Files the mode workflow copies from the harness for one test file only (native-mode-evidence.yml).
const MODE_EXTRAS = {
  'apps/ios/UITests/WinterThemeTests.swift': ['apps/ios/App/Views/ChatStatusFixture.swift'],
  'apps/ios/UITests/KeyboardDismissEvidenceTests.swift': ['apps/ios/Protocol/Tests/NekkoKitTests/StarAskTests.swift'],
  'apps/ios/UITests/SecurityComparisonTests.swift': ['apps/ios/App/Views/SecurityEvidenceFixture.swift'],
  'apps/ios/UITests/QuietTranscriptTests.swift': ['apps/ios/App/Views/ReplyVoicesFixture.swift'],
};
const MODE_VIDEO = new Set(['apps/ios/UITests/QuietTranscriptTests.swift', 'apps/ios/UITests/KeyboardDismissEvidenceTests.swift']);

/** What one evidence run does, from the command line; throws on anything unsafe or missing. */
export function plan(argv) {
  const opts = { overlays: [], onlyTesting: [], afterOnlyTesting: [], env: {}, revisions: ['before', 'after'] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--preset': opts.preset = value(); break;
      case '--baseline': opts.baseline = value(); break;
      case '--source': opts.source = value(); break;
      case '--harness': opts.harness = value(); break;
      case '--label': opts.label = value(); break;
      case '--runtime': opts.runtime = value(); break;
      case '--test-file': opts.testFile = value(); break;
      case '--only-testing': opts.onlyTesting.push(value()); break;
      case '--overlay': opts.overlays.push(value()); break;
      case '--video': opts.video = value(); break;
      case '--only': opts.revisions = [value()]; break;
      case '--keep': opts.keep = true; break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!SHA.test(opts.baseline ?? '') || !SHA.test(opts.source ?? '')) {
    throw new Error('--baseline and --source must be full 40-character commit SHAs, so a moving branch cannot change the comparison');
  }
  if (opts.harness !== undefined && !SHA.test(opts.harness)) throw new Error('--harness must be a full commit SHA');
  opts.harness ??= opts.source;
  opts.runtime ??= DEFAULT_RUNTIME;
  if (!opts.revisions.every(r => r === 'before' || r === 'after')) throw new Error('--only takes before or after');

  const preset = opts.preset ?? 'mode';
  if (preset === 'mode') {
    if (!/^apps\/ios\/UITests\/[A-Za-z0-9_]+\.swift$/.test(opts.testFile ?? '')) throw new Error('--preset mode needs --test-file apps/ios/UITests/<Name>.swift');
    if (!opts.onlyTesting.length) throw new Error('--preset mode needs --only-testing');
    opts.overlays.push(opts.testFile, ...(MODE_EXTRAS[opts.testFile] ?? []));
    if (MODE_VIDEO.has(opts.testFile)) opts.video ??= 'quiet-transcript.mp4';
    opts.patchSecurity = opts.testFile === 'apps/ios/UITests/SecurityComparisonTests.swift';
    opts.baselineEnv = 'TEST_RUNNER_NEKKO_EVIDENCE_BASELINE';
    opts.swiftTest = true;
  } else if (preset === 'groups') {
    opts.overlays.push('apps/ios/scripts/GroupEvidenceTests.swift=apps/ios/UITests/GroupEvidenceTests.swift', 'apps/ios/UITests/PurposeGroupsTests.swift');
    opts.prepare = { script: 'apps/ios/scripts/group-evidence.mjs', args: rev => [`--${rev}`] };
    opts.onlyTesting.push('NekkoNativeUITests/GroupEvidenceTests', 'NekkoNativeUITests/PurposeGroupsTests');
    opts.afterOnlyTesting.push('NekkoNativeTests/ChatGroupPrefsTests');
    opts.video ??= 'groups.mp4';
  } else if (preset === 'computer-settings') {
    opts.overlays.push('apps/ios/App/Views/ComputerSettingsEvidenceFixture.swift', 'apps/ios/UITests/ComputerSettingsEvidenceUITests.swift');
    opts.prepare = { script: 'apps/ios/scripts/computer-settings-evidence.mjs', args: () => [], only: 'before' };
    opts.onlyTesting.push('NekkoNativeUITests/ComputerSettingsEvidenceUITests');
    opts.video ??= 'computer-interaction.mp4';
    opts.baselineEnv = 'TEST_RUNNER_NEKKO_COMPUTER_BASELINE';
    opts.serial = true;
  } else if (preset === 'custom') {
    if (!opts.onlyTesting.length) throw new Error('--preset custom needs --only-testing');
  } else {
    throw new Error(`unknown preset ${preset} (mode, groups, computer-settings, custom)`);
  }
  for (const overlay of opts.overlays) {
    const [from, to = from] = overlay.split('=');
    if ([from, to].some(p => !/^apps\/ios\/[A-Za-z0-9_./-]+$/.test(p) || p.includes('..'))) throw new Error(`overlay outside apps/ios: ${overlay}`);
  }
  if (opts.video && !/^[a-z0-9-]+\.mp4$/.test(opts.video)) throw new Error('--video takes a plain name like groups.mp4');
  opts.preset = preset;
  opts.label ??= preset;
  if (!/^[A-Za-z0-9_.-]+$/.test(opts.label)) throw new Error('--label: letters, digits, dot, dash and underscore only');
  return opts;
}

/** The xcodebuild test arguments for one revision. */
export function testArgs(opts, revision) {
  const ids = revision === 'after' ? [...opts.onlyTesting, ...opts.afterOnlyTesting] : opts.onlyTesting;
  return [...ids.map(id => `-only-testing:${id}`), ...(opts.serial ? ['-parallel-testing-enabled', 'NO'] : [])];
}

/** Adds the security fixture's launch route, as native-mode-evidence.yml does. */
export function patchSecurity(source) {
  if (source.includes('"-uiTestSecurityEvidence"')) return source;
  const flags = 'let flags = ["-uiTestChatRefresh"';
  const needle = '        if ProcessInfo.processInfo.arguments.contains("-uiTestVoiceConversation")';
  if (!source.includes(flags) || !source.includes(needle)) throw new Error('NekkoApp.swift anchors for the security fixture changed');
  return source
    .replace(flags, 'let flags = ["-uiTestSecurityEvidence", "-uiTestChatRefresh"')
    .replace(needle, `        if ProcessInfo.processInfo.arguments.contains("-uiTestSecurityEvidence") { SecurityEvidenceFixture() } else\n${needle}`);
}

/**
 * The name an exported attachment should get: XCTest's suggested name without its
 * `_<index>_<UUID>` suffix (`card-details-menu_0_DEAD...png` -> `card-details-menu.png`),
 * numbered when two attachments share a name.
 */
export function readableName(suggested, taken) {
  const ext = path.extname(suggested);
  const base = path.basename(suggested, ext).replace(/_\d+_[0-9A-F-]{36}$/i, '').replace(/[^A-Za-z0-9_.-]/g, '-') || 'attachment';
  let name = `${base}${ext}`;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}${ext}`;
  taken.add(name);
  return name;
}

/** Renames xcresulttool's UUID file names after manifest.json, which keeps the mapping. */
function readableNames(dir) {
  const manifest = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifest)) return;
  const taken = new Set();
  const tests = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const test of tests) {
    for (const a of test.attachments ?? []) {
      if (!a.exportedFileName || !a.suggestedHumanReadableName) continue;
      const from = path.join(dir, a.exportedFileName);
      if (!fs.existsSync(from)) continue;
      a.exportedFileName = readableName(a.suggestedHumanReadableName, taken);
      fs.renameSync(from, path.join(dir, a.exportedFileName));
    }
  }
  fs.writeFileSync(manifest, `${JSON.stringify(tests, null, 2)}\n`);
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function run(cmd, args, { cwd, log, env } = {}) {
  return new Promise((resolve, reject) => {
    const out = log ? fs.openSync(log, 'a') : 'inherit';
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${code}${log ? `; see ${log}` : ''}`))));
  });
}

function deviceTypeFor(runtime) {
  const { runtimes } = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'runtimes', '-j'], { encoding: 'utf8' }));
  const found = runtimes.find(r => r.isAvailable && r.identifier === runtime);
  // Fail closed: never compare captures from a different OS version than asked for.
  if (!found) throw new Error(`simulator runtime ${runtime} is not installed (xcrun simctl list runtimes)`);
  const pro = found.supportedDeviceTypes.map(d => d.identifier).filter(id => DEVICE_TYPE.test(id));
  if (!pro.length) throw new Error(`no iPhone Pro device type for ${runtime}`);
  return pro.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).at(-1);
}

async function capture(opts, revision, repo) {
  const ref = revision === 'before' ? opts.baseline : opts.source;
  const out = path.join(repo, '.shots', 'ios-evidence', opts.label, revision);
  const tree = path.join(repo, '.shots', 'ios-evidence', opts.label, `${revision}-src`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  if (fs.existsSync(tree)) git(repo, 'worktree', 'remove', '--force', tree);
  git(repo, 'worktree', 'add', '--detach', tree, ref);
  const log = path.join(out, 'build.log');
  let device;
  try {
    for (const overlay of opts.overlays) {
      const [from, to = from] = overlay.split('=');
      const dest = path.join(tree, to);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, execFileSync('git', ['show', `${opts.harness}:${from}`], { cwd: repo }));
    }
    if (opts.patchSecurity) {
      const app = path.join(tree, 'apps/ios/App/NekkoApp.swift');
      fs.writeFileSync(app, patchSecurity(fs.readFileSync(app, 'utf8')));
    }
    if (opts.prepare && (!opts.prepare.only || opts.prepare.only === revision)) {
      const script = path.join(out, path.basename(opts.prepare.script));
      fs.writeFileSync(script, execFileSync('git', ['show', `${opts.harness}:${opts.prepare.script}`], { cwd: repo }));
      await run(process.execPath, [script, ...opts.prepare.args(revision)], { cwd: tree, log });
    }
    const ios = path.join(tree, 'apps/ios');
    if (opts.swiftTest) await run('swift', ['test'], { cwd: path.join(ios, 'Protocol'), log });
    await run('xcodegen', ['generate'], { cwd: ios, log });
    const type = deviceTypeFor(opts.runtime);
    device = execFileSync('xcrun', ['simctl', 'create', `Nekko-Evidence-${opts.label}-${revision}`, type, opts.runtime], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(out, 'revisions.txt'), [
      `app=${git(tree, 'rev-parse', 'HEAD')}`,
      `harness=${opts.harness}`,
      `device=${type} runtime=${opts.runtime}`,
      `machine=local ${execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).trim().replace(/\n/g, ' ')}`,
      '',
    ].join('\n'));
    const common = ['-project', 'NekkoNative.xcodeproj', '-scheme', 'NekkoNative', '-configuration', 'Debug',
      '-destination', `platform=iOS Simulator,id=${device}`, '-derivedDataPath', 'DerivedData',
      'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM=', 'COMPILER_INDEX_STORE_ENABLE=NO'];
    console.log(`${revision}: building ${ref.slice(0, 9)} (log: ${path.relative(repo, log)})`);
    await run('xcodebuild', [...common, 'build-for-testing'], { cwd: ios, log });
    await run('xcrun', ['simctl', 'boot', device], { log });
    await run('xcrun', ['simctl', 'bootstatus', device, '-b'], { log });
    await run('xcrun', ['simctl', 'ui', device, 'appearance', 'light'], { log });
    await run('xcrun', ['simctl', 'status_bar', device, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100'], { log });
    const video = opts.video && spawn('xcrun', ['simctl', 'io', device, 'recordVideo', '--codec=h264', path.join(out, opts.video)], { stdio: 'ignore' });
    const env = opts.baselineEnv ? { [opts.baselineEnv]: revision === 'before' ? '1' : '0' } : {};
    console.log(`${revision}: testing`);
    try {
      await run('xcodebuild', [...common, '-resultBundlePath', path.join(out, 'evidence.xcresult'), 'test-without-building', ...testArgs(opts, revision)], { cwd: ios, log, env });
    } finally {
      if (video) {
        video.kill('SIGINT');
        await new Promise(resolve => video.on('exit', resolve));
      }
    }
  } finally {
    if (device) {
      try { execFileSync('xcrun', ['simctl', 'shutdown', device], { stdio: 'ignore' }); } catch {}
      try { execFileSync('xcrun', ['simctl', 'delete', device], { stdio: 'ignore' }); } catch {}
    }
    const result = path.join(out, 'evidence.xcresult');
    if (fs.existsSync(result)) {
      const shots = path.join(out, 'shots');
      execFileSync('xcrun', ['xcresulttool', 'export', 'attachments', '--path', result, '--output-path', shots], { stdio: 'ignore' });
      readableNames(shots);
    }
    if (!opts.keep) git(repo, 'worktree', 'remove', '--force', tree);
  }
  const shots = fs.existsSync(path.join(out, 'shots')) ? fs.readdirSync(path.join(out, 'shots')).filter(f => f.endsWith('.png')).length : 0;
  if (!shots) throw new Error(`${revision}: the test passed but attached no screenshots`);
  console.log(`${revision}: ${shots} screenshot(s) in ${path.relative(repo, out)}/shots`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'darwin') {
    console.error('iPhone evidence needs a Mac with Xcode. Without one, dispatch the matching evidence workflow (docs/runbooks/visual-evidence.md).');
    process.exit(2);
  }
  let opts;
  try {
    opts = plan(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const repo = git(path.dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel');
  let failed = false;
  // One revision at a time: two Xcode builds at once starve a laptop and any CI runner VM on it.
  for (const revision of opts.revisions) {
    try {
      await capture(opts, revision, repo);
    } catch (error) {
      failed = true;
      console.error(`${revision}: ${error.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

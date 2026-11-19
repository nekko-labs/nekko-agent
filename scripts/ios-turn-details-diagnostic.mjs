import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validate(inputs, { event, ref, environment }) {
  if (event !== 'workflow_dispatch' || !['refs/heads/main', 'refs/heads/ci/ios-batch'].includes(ref)) {
    throw new Error('Diagnostic requires an approved Native iOS dispatch ref');
  }
  if (environment !== 'self-hosted') throw new Error('Owner Mac required; hosted fallback is not matched evidence');
  for (const [key, value] of Object.entries(inputs)) {
    if (key !== 'turn_details_diagnostic' && value !== '' && value !== false && value !== 'false') {
      throw new Error(`Cannot combine diagnostic with ${key}`);
    }
  }
  const pins = JSON.parse(inputs.turn_details_diagnostic);
  if (!pins || Object.keys(pins).sort().join(',') !== 'app,harness'
    || !Object.values(pins).every(v => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v))) {
    throw new Error('Diagnostic requires exactly app and harness full lowercase commit SHAs');
  }
  return pins;
}

// All harness content is data except this single test file. Never overlay app or project code.
export const TEST_FILE = 'apps/ios/UITests/TurnDetailsTests.swift';
export const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-27-2';
export const DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro';
export function selectXcode(candidates, version) {
  const developer = candidates.find(p => version(p).trim() === 'Xcode 27.2\nBuild version 27B52');
  if (!developer) throw new Error('Exact Xcode 27.2 / 27B52 required');
  return developer;
}

// Injected command runner also lets tests prove cleanup and verdict preservation without a simulator.
export function capture({ app, harness }, run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...options }), applications = '/Applications') {
  const evidence = resolve('diagnostic-evidence');
  mkdirSync(evidence, { recursive: true });
  const record = (file, text) => writeFileSync(resolve(evidence, file), text);
  let device;
  let failure;
  let env = process.env;
  const result = resolve(evidence, 'turn-details.xcresult');
  try {
    if (run('git', ['-C', 'source', 'rev-parse', 'HEAD']).trim() !== app
      || run('git', ['-C', 'harness', 'rev-parse', 'HEAD']).trim() !== harness) throw new Error('Checkout pins differ');
    record('revisions.txt', `app=${app}\nharness=${harness}\nworkflow=${process.env.GITHUB_SHA}\n`);
    const candidates = readdirSync(applications).filter(n => /^Xcode.*\.app$/.test(n))
      .map(n => `${applications}/${n}/Contents/Developer`);
    const developer = selectXcode(candidates, p => {
      try { return run('xcodebuild', ['-version'], { env: { ...process.env, DEVELOPER_DIR: p } }); } catch { return ''; }
    });
    env = { ...process.env, DEVELOPER_DIR: developer };
    record('developer.txt', developer);
    const command = (cmd, args) => {
      if (['swift', 'xcodegen'].includes(cmd) || cmd === 'xcodebuild' && !args.includes('-version')) {
        const log = openSync(resolve(evidence, 'build.log'), 'a');
        try { return run(cmd, args, { env, cwd: resolve('source/apps/ios'), stdio: ['ignore', log, log] }); }
        finally { closeSync(log); }
      }
      return run(cmd, args, { env, cwd: resolve('source/apps/ios') });
    };
    record('host.txt', `${run('sw_vers', [])}\n${run('locale', [])}\n${command('xcodebuild', ['-version'])}`);
    const runtimes = JSON.parse(command('xcrun', ['simctl', 'list', 'runtimes', '-j']));
    record('runtimes.json', JSON.stringify(runtimes, null, 2));
    if (!runtimes.runtimes.some(r => r.isAvailable && r.identifier === RUNTIME && r.buildversion === '24B8117')) {
      throw new Error('Exact iOS 27.2 / 24B8117 runtime required');
    }
    const test = run('git', ['-C', 'harness', 'show', `${harness}:${TEST_FILE}`]);
    writeFileSync(resolve('source', TEST_FILE), test);
    command('swift', ['test', '--package-path', 'Protocol']);
    command('xcodegen', ['generate']);
    device = command('xcrun', ['simctl', 'create', 'Nekko-Turn-Details-Diagnostic', DEVICE_TYPE, RUNTIME]).trim();
    record('device.txt', `${device}\n${DEVICE_TYPE}\n${RUNTIME}\n`);
    command('xcrun', ['simctl', 'boot', device]);
    command('xcrun', ['simctl', 'bootstatus', device, '-b']);
    command('xcrun', ['simctl', 'ui', device, 'appearance', 'light']);
    command('xcrun', ['simctl', 'status_bar', device, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100']);
    // Read only these locale/accessibility domains, never dump simulator accounts or credentials.
    for (const domain of ['NSGlobalDomain', 'com.apple.Accessibility']) {
      try { record(`${domain}.txt`, command('xcrun', ['simctl', 'spawn', device, 'defaults', 'read', domain])); }
      catch { record(`${domain}.txt`, 'Domain unavailable before test launch\n'); }
    }
    const common = ['-project', 'NekkoNative.xcodeproj', '-scheme', 'NekkoNative', '-configuration', 'Debug',
      '-destination', `platform=iOS Simulator,id=${device}`, '-derivedDataPath', 'DerivedData',
      'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM=', 'COMPILER_INDEX_STORE_ENABLE=NO'];
    command('xcodebuild', [...common, 'build-for-testing']);
    command('xcodebuild', [...common, '-resultBundlePath', result, 'test-without-building',
      '-only-testing:NekkoNativeUITests/TurnDetailsTests']);
  } catch (error) {
    failure = error;
    record('failure.txt', `${error.message}\n`);
  } finally {
    // Export failure never replaces the native verdict, and cannot prevent owned-device cleanup.
    if (existsSync(result)) {
      for (const [file, args] of [
        ['summary.json', ['get', 'test-results', 'summary', '--path', result]],
        ['export.txt', ['export', 'attachments', '--path', result, '--output-path', resolve(evidence, 'shots')]],
      ]) {
        try { record(file, run('xcrun', ['xcresulttool', ...args], { env })); }
        catch (error) { record(`${file}.error.txt`, `${error.message}\n`); failure ??= error; }
      }
    }
    if (device) {
      for (const action of ['shutdown', 'delete']) {
        try { run('xcrun', ['simctl', action, device], { env }); }
        catch (error) { record(`${action}.error.txt`, `${error.message}\n`); failure ??= error; }
      }
    }
  }
  if (failure) throw failure;
  const summary = JSON.parse(readFileSync(resolve(evidence, 'summary.json'), 'utf8'));
  if (summary.totalTestCount !== 8 || summary.passedTests !== 8 || summary.failedTests !== 0 || summary.skippedTests !== 0) {
    throw new Error('Diagnostic requires all eight tests passing with none skipped; inspect retained summary');
  }
  if (!readdirSync(resolve(evidence, 'shots')).some(n => n.endsWith('.png'))) throw new Error('Native screenshots missing');
}

export function cleanup(run = (cmd, args, options) => execFileSync(cmd, args, options)) {
  if (!existsSync('diagnostic-evidence/device.txt')) return;
  const device = readFileSync('diagnostic-evidence/device.txt', 'utf8').split('\n')[0];
  if (!/^[0-9a-f-]{36}$/i.test(device)) throw new Error('Invalid owned simulator receipt');
  const env = { ...process.env, DEVELOPER_DIR: readFileSync('diagnostic-evidence/developer.txt', 'utf8') };
  for (const action of ['shutdown', 'delete']) {
    try { run('xcrun', ['simctl', action, device], { env }); } catch { /* Already cleaned in capture finally. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'cleanup') { cleanup(); process.exit(0); }
  const pins = validate(JSON.parse(process.env.DISPATCH_INPUTS), {
    event: process.env.WORKFLOW_EVENT, ref: process.env.WORKFLOW_REF, environment: process.env.RUNNER_ENVIRONMENT,
  });
  if (process.argv[2] === 'validate') console.log(`app=${pins.app}\nharness=${pins.harness}`);
  else if (process.argv[2] === 'capture') capture(pins);
  else throw new Error('Expected validate or capture');
}

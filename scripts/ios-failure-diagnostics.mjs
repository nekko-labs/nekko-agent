#!/usr/bin/env node
/** Preserve first-attempt failures even when a later xcresult passes (#831/#1048). */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function exportFailureDiagnostics(root, { run = execFileSync, log = console.log } = {}) {
  const exported = [];
  if (!existsSync(root)) return exported;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.xcresult')) continue;
    const stem = entry.name.slice(0, -'.xcresult'.length);
    if (!stem || stem === '.' || stem === '..') continue;
    const bundle = join(root, entry.name);
    let summary;
    let summaryError;
    try {
      summary = JSON.parse(run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle], {
        encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch (e) {
      summaryError = String(e.message);
    }
    // Unknown/incomplete results may contain the only app-launch diagnostics.
    if (summary?.result === 'Passed' && summary.failedTests === 0 && !summary.testFailures?.length) continue;
    const out = join(root, 'diagnostics', stem);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    if (summary) writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    if (summaryError) writeFileSync(join(out, 'summary-error.txt'), summaryError + '\n');
    // Xcode also exports a host-wide simctl_diagnostics tree. Stage outside
    // upload paths, retaining the test logs but never that unrelated archive.
    const staging = mkdtempSync(join(tmpdir(), 'nekko-ios-diagnostics-raw-'));
    const raw = join(staging, 'xcode');
    try {
      run('xcrun', ['xcresulttool', 'export', 'diagnostics', '--path', bundle, '--output-path', raw], {
        encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      cpSync(raw, join(out, 'xcode'), {
        recursive: true,
        filter: path => !path.split(sep).includes('simctl_diagnostics'),
      });
      log(`Exported failure diagnostics: ${entry.name}`);
    } catch (e) {
      // Keep the test verdict and continue to other results if Xcode cannot export.
      writeFileSync(join(out, 'export-error.txt'), String(e.message) + '\n');
      log(`Could not export diagnostics: ${entry.name} (see export-error.txt)`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    exported.push(out);
  }
  return exported;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/ios-failure-diagnostics.mjs <results-directory>');
    process.exitCode = 2;
  } else {
    exportFailureDiagnostics(resolve(process.argv[2]));
  }
}

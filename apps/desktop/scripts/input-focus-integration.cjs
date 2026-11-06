// node apps/desktop/scripts/input-focus-integration.cjs [--baseline]
// NEKKO_TEST_SOURCE can select an unchanged checkout for matched baseline proof.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const baseline = process.argv.includes('--baseline');
const label = process.env.NEKKO_TEST_LABEL || `input-focus-${baseline ? 'before' : 'after'}`;
const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'layout-evidence-integration.cjs')], {
  cwd: repo, windowsHide: true, stdio: 'inherit', timeout: 120000,
  env: { ...process.env, NEKKO_LAYOUT_FIXTURE: 'input-focus-fixture.tsx', NEKKO_LAYOUT_SANDBOX: 'input-focus-sandbox.cjs', NEKKO_TEST_LABEL: label, NEKKO_FOCUS_BASELINE: baseline ? '1' : '0' },
});
fs.rmSync(path.join(repo, '.shots/layout-evidence', label, 'profile'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

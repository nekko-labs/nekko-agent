// Usage: node apps/desktop/scripts/model-card-integration.cjs [baseline-worktree]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const baseline = process.argv[2];
const source = baseline ? path.resolve(baseline) : repo;
const label = baseline ? 'before' : 'after';
const out = path.join(repo, '.shots/layout-evidence', label);
const renderer = path.relative(out, path.join(source, 'apps/desktop/src/renderer')).replaceAll('\\', '/');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'page-input.css'), `@import "${renderer}/styles.css";\n@source "${renderer}";\n`);
const result = spawnSync(process.execPath, [path.join(__dirname, 'layout-evidence-integration.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, NEKKO_TEST_SOURCE: source, NEKKO_TEST_LABEL: label, NEKKO_LAYOUT_STYLES: 'page-input.css', NEKKO_LAYOUT_FIXTURE: 'model-card-fixture.tsx', NEKKO_LAYOUT_SANDBOX: 'model-card-sandbox.cjs', NEKKO_CARD_CHECK: baseline ? '' : '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

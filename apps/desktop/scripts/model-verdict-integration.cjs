// Usage: node apps/desktop/scripts/model-verdict-integration.cjs [baseline-worktree]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const source = process.argv[2] ? path.resolve(process.argv[2]) : repo;
const label = process.argv[2] ? 'model-verdict-before' : 'model-verdict-after';
const out = path.join(repo, '.shots/layout-evidence', label);
const renderer = path.relative(out, path.join(source, 'apps/desktop/src/renderer')).replaceAll('\\', '/');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'page-input.css'), `@import "${renderer}/styles.css";\n@source "${renderer}";\n`);
const result = spawnSync(process.execPath, [path.join(__dirname, 'layout-evidence-integration.cjs')], { stdio: 'inherit', env: { ...process.env, NEKKO_TEST_SOURCE: source, NEKKO_TEST_LABEL: label, NEKKO_LAYOUT_STYLES: 'page-input.css', NEKKO_LAYOUT_FIXTURE: 'model-verdict-fixture.tsx', NEKKO_LAYOUT_SANDBOX: 'model-verdict-sandbox.cjs' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

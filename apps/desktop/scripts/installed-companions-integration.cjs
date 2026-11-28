// Run before edits with --before, or point --before at an unchanged worktree with NEKKO_TEST_SOURCE.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const source = process.env.NEKKO_TEST_SOURCE || repo;
const label = process.argv.includes('--before') ? 'installed-companions-before' : 'installed-companions-after';
const out = path.join(repo, '.shots/layout-evidence', label);
const renderer = path.relative(out, path.join(source, 'apps/desktop/src/renderer')).replaceAll('\\', '/');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'companion-layout.css'), `@import "${renderer}/styles.css";\n@source "${renderer}";\n`);
const result = spawnSync(process.execPath, [path.join(__dirname, 'layout-evidence-integration.cjs')], {
  stdio: 'inherit', env: { ...process.env, NEKKO_LAYOUT_STYLES: 'companion-layout.css', NEKKO_TEST_LABEL: label, NEKKO_LAYOUT_FIXTURE: 'installed-companions-fixture.tsx', NEKKO_LAYOUT_SANDBOX: 'installed-companions-sandbox.cjs' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

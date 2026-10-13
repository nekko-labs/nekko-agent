import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const primary = resolve(process.env.NEKKO_FIXTURE_PRIMARY || '../..');
const require = createRequire(resolve(primary, 'package.json'));
const { build } = require('esbuild');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');
const out = resolve(process.env.NEKKO_FIXTURE_OUT || '.shots/ask-transcript-fixture');
const renderer = 'apps/desktop/src/renderer';
mkdirSync(out, { recursive: true });
const git = args => execFileSync('git', args, { windowsHide: true });
const baseline = git(['rev-parse', process.env.NEKKO_FIXTURE_BASELINE || '1044834c']).toString().trim();
const files = git(['ls-tree', '-r', '--name-only', baseline, renderer]).toString().trim().split('\n');
for (const f of files) { const p = resolve(out, 'baseline-source', f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, git(['show', `${baseline}:${f}`])); }
const aliases = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@nekko-agent/shared': resolve(primary, 'packages/shared/src/index.ts') };
for (const version of ['baseline', 'after']) {
  const src = version === 'baseline' ? resolve(out, 'baseline-source', renderer) : resolve(renderer);
  const dir = resolve(out, version, 'dist'); mkdirSync(dir, { recursive: true });
  const chat = readFileSync(resolve(src, 'components/ChatPane.tsx'), 'utf8');
  const start = chat.indexOf('const TranscriptRowView = memo(');
  const end = chat.indexOf('\n});', start) + 4;
  if (start < 0 || end < start) throw new Error('Production row view extraction failed');
  const fixture = readFileSync('scripts/itest-ask-transcript.fixture.tsx', 'utf8').replaceAll('__SOURCE__', src.replaceAll('\\', '/')).replace('__ROW_VIEW__', chat.slice(start, end));
  const entry = resolve(out, version, 'fixture.tsx'); writeFileSync(entry, fixture);
  await build({ entryPoints: [entry], bundle: true, outfile: resolve(dir, 'fixture.js'), platform: 'browser', mainFields: ['browser', 'module', 'main'], alias: aliases, nodePaths: [resolve(primary, 'node_modules')], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const css = await postcss([tailwind({ base: primary })]).process(readFileSync(resolve(src, 'styles.css'), 'utf8'), { from: resolve(src, 'styles.css'), to: resolve(dir, 'styles.css') });
  writeFileSync(resolve(dir, 'styles.css'), css.css);
  writeFileSync(resolve(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><style>body{margin:0;background:var(--surface)}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
}
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ baseline, primary, renderer: resolve(renderer), aliases, description: 'Exact production TranscriptRowView extracted without modifying parent code; actual toTranscriptRows, MessageBubble and ActivityGroup.', inspected: false }, null, 2));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [resolve('scripts/itest-ask-transcript.electron.cjs'), out], { windowsHide: true, stdio: 'inherit', env });
const timer = setTimeout(() => { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGKILL'); }, 100000);
child.on('exit', code => { clearTimeout(timer); rmSync(resolve(out, 'profile'), { recursive: true, force: true }); process.exitCode = code ?? 1; });

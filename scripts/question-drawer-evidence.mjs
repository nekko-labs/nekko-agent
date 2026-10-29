import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const primary = resolve(process.env.NEKKO_FIXTURE_PRIMARY || '../..');
const require = createRequire(resolve(primary, 'package.json'));
const { build } = require('esbuild');
const postcss = require('postcss'); const tailwind = require('@tailwindcss/postcss');
const out = resolve('.shots/question-drawer'); mkdirSync(out, { recursive: true });
const renderer = 'apps/desktop/src/renderer';
const base = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
for (const f of execFileSync('git', ['ls-tree', '-r', '--name-only', base, renderer]).toString().trim().split('\n')) {
 const p = resolve(out, 'baseline-source', f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, execFileSync('git', ['show', `${base}:${f}`]));
}
for (const version of ['baseline', 'after']) {
 const src = version === 'baseline' ? resolve(out, 'baseline-source', renderer) : resolve(renderer);
 const dir = resolve(out, version, 'dist'); mkdirSync(dir, { recursive: true });
 const fixture = readFileSync('scripts/question-drawer.fixture.tsx', 'utf8').replaceAll('__SOURCE__', src).replaceAll('__BASELINE__', String(version === 'baseline'));
 const entry = resolve(out, version, 'fixture.tsx'); writeFileSync(entry, fixture);
 await build({ entryPoints: [entry], bundle: true, outfile: resolve(dir, 'fixture.js'), platform: 'browser', nodePaths: [resolve(primary, 'node_modules')], alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@nekko-agent/shared': resolve(primary, 'packages/shared/src/index.ts') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
 const css = await postcss([tailwind({ base: primary })]).process(readFileSync(resolve(src, 'styles.css'), 'utf8'), { from: resolve(src, 'styles.css') });
 writeFileSync(resolve(dir, 'styles.css'), css.css);
 writeFileSync(resolve(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script src="fixture.js"></script>');
}
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ base, note: 'Actual production VirtualTranscript and QuestionCard; parent layout reproduced from ChatPane, synthetic data, no host or provider.' }, null, 2));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync(require('electron'), [resolve('scripts/question-drawer.electron.cjs'), out], { env, stdio: 'inherit', timeout: 100000 }); process.exitCode = run.status ?? 1;

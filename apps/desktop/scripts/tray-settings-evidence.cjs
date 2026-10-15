const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const out = path.join(repo, '.shots/tray-companion');
async function main() {
  const base = process.argv.includes('--base');
  const dir = path.join(out, base ? 'before' : 'after'); fs.mkdirSync(dir, { recursive: true });
  let source = repo;
  if (base) {
    source = path.join(out, 'base-source'); fs.mkdirSync(source, { recursive: true });
    const zip = path.join(out, 'base.zip');
    cp.execFileSync('git', ['archive', '--format=zip', `--output=${zip}`, 'e8b40f81', 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo });
    cp.execFileSync('python', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, source]);
  }
  fs.writeFileSync(path.join(dir, 'fixture.tsx'), fs.readFileSync(path.join(__dirname, 'tray-settings-fixture.tsx'), 'utf8').replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
  await require('esbuild').build({ entryPoints: [path.join(dir, 'fixture.tsx')], bundle: true, jsx: 'automatic', format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [path.join(repo, 'node_modules')], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error' });
  const cssPath = path.join(source, 'apps/desktop/src/renderer/styles.css');
  const css = await require('postcss')([require('@tailwindcss/postcss')({ base: source })]).process(fs.readFileSync(cssPath, 'utf8'), { from: cssPath });
  fs.writeFileSync(path.join(dir, 'styled.css'), css.css);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root" style="height:100vh"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_TRAY_EVIDENCE_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  const child = cp.spawn(require('electron'), [path.join(__dirname, 'tray-evidence-sandbox.cjs')], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => process.exit(code || 0));
}
main().catch(e => { console.error(e); process.exitCode = 1; });

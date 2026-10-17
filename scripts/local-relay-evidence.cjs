// Before/after renderer evidence for "Relay on this computer" in Settings →
// Remote access. Builds one synthetic fixture against the base revision and the
// working tree, then captures it in headless Chromium (Playwright's, never the
// user's browser) with a throwaway profile and every non-local request blocked.
// Usage: node scripts/local-relay-evidence.cjs   (EVIDENCE_BASE=<rev>, CHROME=<path>)
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const repo = path.resolve(__dirname, '..'), out = path.join(repo, '.shots/local-relay'), base = process.env.EVIDENCE_BASE || 'HEAD';
const resolve = (x) => require.resolve(x, { paths: [path.join(repo, 'apps/desktop'), repo] });
const chrome = process.env.CHROME || [...(fs.existsSync('/opt/pw-browsers') ? fs.readdirSync('/opt/pw-browsers') : [])]
  .filter((d) => d.startsWith('chromium-')).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p));

async function build(kind) {
  const dir = path.join(out, kind);
  fs.mkdirSync(dir, { recursive: true });
  let entry = path.join(__dirname, 'local-relay-evidence-fixture.tsx'), shared = path.join(repo, 'packages/shared/src/index.ts');
  if (kind === 'before') {
    const source = path.join(dir, 'source');
    const files = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim().split('\n');
    for (const p of files) {
      const dest = path.join(source, p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, cp.execFileSync('git', ['show', `${base}:${p}`], { cwd: repo, maxBuffer: 20e6, windowsHide: true }));
    }
    entry = path.join(dir, 'fixture.tsx');
    fs.writeFileSync(entry, fs.readFileSync(path.join(__dirname, 'local-relay-evidence-fixture.tsx'), 'utf8').replaceAll('../apps/desktop/src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/')));
    shared = path.join(source, 'packages/shared/src/index.ts');
  }
  const modules = path.resolve(path.dirname(resolve('esbuild')), '../..');
  await require(resolve('esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(dir, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': shared }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' }, logLevel: 'error' });
  const css = await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({ base: repo })]).process(fs.readFileSync(path.join(dir, 'fixture.css'), 'utf8'), { from: path.join(dir, 'fixture.css') });
  fs.writeFileSync(path.join(dir, 'styled.css'), css.css);
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
  fs.rmSync(path.join(dir, 'source'), { recursive: true, force: true });
  return dir;
}

(async () => {
  if (!chrome) throw new Error('No Chromium found; set CHROME to a Chromium binary (never your everyday browser profile).');
  fs.rmSync(out, { recursive: true, force: true });
  const { chromium } = require(resolve('playwright-core'));
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  const report = { checks: [], errors: [], captures: [] };
  try {
    for (const kind of ['before', 'after']) {
      const dir = await build(kind);
      // `before` has no relay card: one state shows the whole difference.
      const scenarios = kind === 'before' ? ['tailscale', 'in-use'] : ['tailscale', 'running', 'no-tailscale', 'in-use'];
      for (const width of [900, 420]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
        await context.route('**/*', (r) => (/^(file:|data:|blob:)/.test(r.request().url()) ? r.continue() : r.abort()));
        const page = await context.newPage();
        page.on('console', (m) => m.type() === 'error' && report.errors.push(`${kind}: ${m.text()}`));
        page.on('pageerror', (e) => report.errors.push(`${kind}: ${e.message}`));
        for (const scenario of width === 900 ? scenarios : ['running']) {
          for (const theme of width === 900 ? ['light', 'dark'] : ['light']) {
            await page.goto(`file://${path.join(dir, 'index.html')}?s=${scenario}`);
            await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
            await page.waitForSelector('[data-shot=remote] section');
            await page.waitForTimeout(400);
            const file = path.join(dir, `${scenario}-${theme}-${width}.png`);
            await page.locator('[data-shot=remote]').screenshot({ path: file });
            report.captures.push(path.relative(repo, file));
            if (kind === 'after') {
              const card = await page.locator('[data-shot=local-relay]').count();
              report.checks.push({ name: `${scenario} ${theme} ${width}px: relay card shown`, passed: card === 1 });
              const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
              report.checks.push({ name: `${scenario} ${theme} ${width}px: no horizontal overflow`, passed: !overflow });
            }
          }
        }
        await context.close();
      }
    }
  } catch (e) {
    report.errors.push(String(e?.stack ?? e));
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(report, null, 2));
    const failed = report.checks.filter((c) => !c.passed);
    console.log(JSON.stringify({ captures: report.captures.length, failed, errors: report.errors }, null, 1));
    if (failed.length || report.errors.length) process.exitCode = 1;
  }
})();

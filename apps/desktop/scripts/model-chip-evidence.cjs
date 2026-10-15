// Production chip class names/CSS; synthetic names; isolated local-only renderer.
const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
const root = path.resolve(__dirname, '../../..'); const dir = path.join(root, '.shots/model-chip'); fs.mkdirSync(dir, { recursive: true });
async function build() {
  for (const state of ['before', 'after']) {
    const src = state === 'before' ? cp.execFileSync('git', ['show', 'HEAD:apps/desktop/src/renderer/components/agent-console/ModelPicker.tsx'], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/components/agent-console/ModelPicker.tsx'), 'utf8');
    const name = src.match(/<span className="([^"]+)"[^>]*>\{unavailableModel \?/)[1];
    const provider = src.match(/<span className="([^"]*ctl-menu-label[^"]*)"/)[1];
    const caret = src.match(/<span className="([^"]*ctl-caret[^"]*)"/)[1];
    const chip = label => `<div style="width:240px"><button class="ctl-menu max-w-full"><span class="${name}" data-name>${label}</span><span class="${provider}">· Anthropic (Claude) · philip@example.com</span><span class="${caret}">▾</span></button></div>`;
    fs.writeFileSync(path.join(dir, `${state}.html`), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data:"><link rel="stylesheet" href="style.css"></head><body style="background:var(--paper);color:var(--ink);padding:32px"><h1>${state} · model chip fixture</h1><div style="display:grid;gap:24px;margin-top:24px">${chip('Claude Opus 4.6')}${chip('Qwen3.8-27B-Q6_K')}${chip('An exceptionally long model name that must wrap')}</div></body></html>`);
  }
  const cssPath = path.join(root, 'apps/desktop/src/renderer/styles.css');
  const css = await require('postcss')([require('@tailwindcss/postcss')({ base: root })]).process(fs.readFileSync(cssPath, 'utf8'), { from: cssPath });fs.writeFileSync(path.join(dir, 'style.css'), css.css);
  const env = { ...process.env, NEKKO_CHIP_DIR: dir };delete env.ELECTRON_RUN_AS_NODE;
  const child = cp.spawn(require('electron'), [path.join(__dirname, 'model-chip-sandbox.cjs')], { env, stdio: 'inherit' });child.on('exit', c => process.exit(c || 0));
}
build().catch(e => { console.error(e); process.exitCode = 1; });

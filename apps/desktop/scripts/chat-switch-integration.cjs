// Synthetic mounted chat-switch check. Never launches the normal app or host.
// Run with Node; NEKKO_TEST_REVISION=<rev> checks that revision's renderer instead.
// Only this worktree's ignored .shots directory is written.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = process.env.NEKKO_TEST_MODULES || path.join(repo, 'node_modules');
const base = process.env.NEKKO_TEST_REVISION;
const out = path.join(repo, '.shots/chat-switch', base ? 'before' : 'after');
async function main() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  let source = repo;
  if (base) {
    source = path.join(out, 'base-source'); fs.mkdirSync(source, { recursive: true });
    const zip = path.join(out, 'base.zip');
    cp.execFileSync('git', ['archive', '--format=zip', `--output=${zip}`, base, 'apps/desktop/src/renderer', 'packages/shared/src'], { cwd: repo });
    cp.execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, source]);
  }
  const renderer = path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/');
  let fixture = fs.readFileSync(path.join(__dirname, 'command-center-fixture.tsx'), 'utf8').replaceAll('../src/renderer', renderer);
  const swap = (from, to) => { if (!fixture.includes(from)) throw Error(`command-center-fixture.tsx changed: ${from}`); fixture = fixture.replace(from, to); };
  const image = (color) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`).toString('base64');
  fixture = `import { ChatPane } from ${JSON.stringify(renderer + '/components/ChatPane')};\nimport { saveDraft, loadDraft } from ${JSON.stringify(renderer + '/composerDrafts')};\nconst imageA = ${JSON.stringify(image('#e65b51'))}, imageB = ${JSON.stringify(image('#457be6'))};\n` + fixture;
  swap("records = [makeSession('existing')]", "records = [makeSession('existing'), { ...makeSession('other'), title: 'Other conversation' }]");
  swap('const [epoch, setEpoch]', "const [chat, setChat] = useState('existing'); Object.assign(window, { switchChat: setChat, loadDraft, seedDrafts: () => { saveDraft('existing', { text: 'Alpha', images: [imageA, imageA] }); saveDraft('other', { text: 'Beta', images: [imageB] }); } }); const [epoch, setEpoch]");
  swap("route === 'command' ? <CommandCenterView />", "route === 'lifecycle' ? <ChatPane sessionId={chat} /> : route === 'command' ? <CommandCenterView />");
  const entry = path.join(out, 'fixture.tsx');
  fs.writeFileSync(entry, fixture);
  await require(path.join(modules, 'esbuild')).build({ entryPoints: [entry], bundle: true, jsx: 'automatic', conditions: ['style', 'browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), nodePaths: [modules], alias: { '@nekko-agent/shared': path.join(source, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  const css = await require(path.join(modules, 'postcss'))([require(path.join(modules, '@tailwindcss/postcss/dist/index.js'))({ base: repo })]).process(fs.readFileSync(path.join(out, 'fixture.css'), 'utf8'), { from: path.join(out, 'fixture.css') });
  fs.writeFileSync(path.join(out, 'styled.css'), css.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env = { ...process.env, NEKKO_INTEGRATION_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require(path.join(modules, 'electron')), [path.join(__dirname, 'chat-switch-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 240000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

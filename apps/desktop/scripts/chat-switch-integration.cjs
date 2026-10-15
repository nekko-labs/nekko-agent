// Synthetic mounted renderer evidence. Never launches the normal app or host.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const modules = path.join(root, 'node_modules');
const source = path.resolve(process.argv[2] || root);
const label = process.argv[3] || 'after';
const out = path.join(root, '.shots/chat-switch-perf', `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
async function main() {
  fs.mkdirSync(out, { recursive: true });
  let fixture = fs.readFileSync(path.join(__dirname, 'command-center-fixture.tsx'), 'utf8');
  fixture = fixture.replaceAll('../src/renderer', path.join(source, 'apps/desktop/src/renderer').replaceAll('\\', '/'));
  fixture = fixture.replace("records = [makeSession('existing')]", "records = [makeSession('existing'), makeSession('other'), makeSession('blank')]");
  fixture = fixture.replace("import React, { useState }", "import React, { useState }");
  fixture = `import {ChatPane} from ${JSON.stringify(path.join(source, 'apps/desktop/src/renderer/components/ChatPane').replaceAll('\\','/'))};\nimport {saveDraft,loadDraft} from ${JSON.stringify(path.join(source, 'apps/desktop/src/renderer/composerDrafts').replaceAll('\\','/'))};\n` + fixture;
  fixture = fixture.replace("const [epoch, setEpoch]", "const [chat,setChat]=useState('existing'); Object.assign(window,{switchChat:setChat,loadDraft,seedDrafts:()=>{saveDraft('existing',{text:'Alpha',images:[imageA,imageA]});saveDraft('other',{text:'Beta',images:[imageB]});}}); const [epoch, setEpoch]");
  fixture = fixture.replace("{route === 'command' ? <CommandCenterView /> : <WorkspacesView />}", "{route === 'lifecycle' ? <ChatPane sessionId={chat} /> : route === 'command' ? <CommandCenterView /> : <WorkspacesView />}");
  const image = color => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`).toString('base64');
  fixture = `const imageA=${JSON.stringify(image('#e65b51'))},imageB=${JSON.stringify(image('#457be6'))};\n` + fixture;
  const entry = path.join(out, 'fixture.tsx'); fs.writeFileSync(entry, fixture);
  await require('esbuild').build({entryPoints:[entry],bundle:true,jsx:'automatic',conditions:['style','browser','import','default'],format:'iife',outfile:path.join(out,'fixture.js'),nodePaths:[modules],alias:{'@agent-nekko/shared':path.join(source,'packages/shared/src/index.ts'),'react':path.dirname(require.resolve('react/package.json')),'react-dom/server':path.join(path.dirname(require.resolve('react-dom/package.json')),'server.browser.js'),'react-dom':path.dirname(require.resolve('react-dom/package.json'))},loader:{'.woff2':'dataurl','.svg':'dataurl','.png':'dataurl','.wasm':'file'}});
  const css = await require('postcss')([require('@tailwindcss/postcss')({base:source})]).process(fs.readFileSync(path.join(out,'fixture.css'),'utf8'),{from:path.join(out,'fixture.css')}); fs.writeFileSync(path.join(out,'styled.css'),css.css);
  fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
  const env={...process.env,NEKKO_SWITCH_OUT:out,NEKKO_SWITCH_SOURCE:source}; delete env.ELECTRON_RUN_AS_NODE;
  const result=cp.spawnSync(require('electron'),[path.join(__dirname,'chat-switch-sandbox.cjs')],{cwd:root,env,windowsHide:true,stdio:'inherit',timeout:120000});
  if(result.error) throw result.error; process.exitCode=result.status ?? 1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});

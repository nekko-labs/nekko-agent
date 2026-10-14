// Verification only: identical fixture bundled against archived base and working tree.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = path.join(repo, 'node_modules');
const root = path.join(repo, '.shots/background-panels');
async function main() {
  fs.mkdirSync(root, { recursive: true });
  const source = fs.mkdtempSync(path.join(root, 'base-source-'));
  const zip = path.join(source, 'base.zip');
  cp.execFileSync('git', ['archive', '--format=zip', '--output='+zip, '1044834c', 'apps/desktop/src', 'packages/shared/src'], {cwd:repo,windowsHide:true});
  cp.execFileSync('powershell', ['-NoProfile','-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zip}', '${source}')`], {windowsHide:true});
  try {
    for (const phase of ['before','after']) {
      const out = path.join(root, phase); fs.mkdirSync(out,{recursive:true});
      const renderer = path.join(phase==='before'?source:repo,'apps/desktop/src/renderer').replaceAll('\\','/');
      const entry = path.join(out,'fixture.tsx');
      fs.writeFileSync(entry,fs.readFileSync(path.join(__dirname,'background-panels-fixture.tsx'),'utf8').replaceAll('../src/renderer',renderer));
      await require('esbuild').build({entryPoints:[entry],bundle:true,jsx:'automatic',conditions:['style','browser','import','default'],format:'iife',outfile:path.join(out,'fixture.js'),nodePaths:[modules],alias:{'@nekko-agent/shared':path.join(phase==='before'?source:repo,'packages/shared/src/index.ts')},loader:{'.woff2':'dataurl','.svg':'dataurl','.png':'dataurl','.wasm':'file'}});
      const css=await require('postcss')([require('@tailwindcss/postcss')({base:repo})]).process(fs.readFileSync(path.join(out,'fixture.css'),'utf8'),{from:path.join(out,'fixture.css')});
      fs.writeFileSync(path.join(out,'styled.css'),css.css);
      fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
      const env={...process.env,NEKKO_INTEGRATION_OUT:out,NEKKO_PHASE:phase}; delete env.ELECTRON_RUN_AS_NODE;
      const child=cp.spawn(require('electron'),[path.join(__dirname,'background-panels-sandbox.cjs')],{cwd:repo,env,windowsHide:true,stdio:'inherit'});
      fs.writeFileSync(path.join(out,'owned-pid.txt'),String(child.pid));
      const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cp.spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});reject(Error('Fixture timed out'));},180000); child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);resolve(code);});});
      // Whole-tree cleanup only for this owned PID, including crash paths.
      cp.spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      for(const name of fs.readdirSync(out)) if(name.startsWith('profile-')) fs.rmSync(path.join(out,name),{recursive:true,force:true,maxRetries:5,retryDelay:300});
      if(code!==0) process.exitCode=1;
    }
  } finally { fs.rmSync(source,{recursive:true,force:true,maxRetries:5,retryDelay:300}); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

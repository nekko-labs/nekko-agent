// Isolated evidence for the focus-mode clean start and the Agent Monitor Tasks
// section: a hidden, unfocusable Electron window with a temp profile and every
// non-file request cancelled. `before` builds the same fixture against
// origin/main's renderer. Output: .shots/tasks-focus-evidence/{before,after}.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'.shots/tasks-focus-evidence'),base=process.env.BASE_REV||'origin/main';
const resolve=x=>require.resolve(x,{paths:[path.join(repo,'apps/desktop'),repo]});
(async()=>{for(const kind of ['before','after']){const dir=path.join(out,kind);fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
let entry=path.join(__dirname,'tasks-focus-evidence-fixture.tsx'),shared=path.join(repo,'packages/shared/src/index.ts');
if(kind==='before'){const source=path.join(dir,'source');for(const p of cp.execFileSync('git',['ls-tree','-r','--name-only',base,'apps/desktop/src/renderer','packages/shared/src'],{cwd:repo,encoding:'utf8'}).trim().split('\n')){const dest=path.join(source,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,cp.execFileSync('git',['show',`${base}:${p}`],{cwd:repo,maxBuffer:20e6}));}
entry=path.join(dir,'fixture.tsx');fs.writeFileSync(entry,fs.readFileSync(path.join(__dirname,'tasks-focus-evidence-fixture.tsx'),'utf8').replaceAll('../apps/desktop/src/renderer',path.join(source,'apps/desktop/src/renderer')));shared=path.join(source,'packages/shared/src/index.ts');}
const modules=path.resolve(path.dirname(resolve('esbuild')),'../..');
await require(resolve('esbuild')).build({entryPoints:[entry],bundle:true,jsx:'automatic',conditions:['style','browser','import','default'],format:'iife',outfile:path.join(dir,'fixture.js'),nodePaths:[modules],alias:{'@nekko-agent/shared':shared},loader:{'.woff2':'dataurl','.svg':'dataurl','.png':'dataurl','.wasm':'file'},logLevel:'error'});
const css=await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({base:repo})]).process(fs.readFileSync(path.join(dir,'fixture.css'),'utf8'),{from:path.join(dir,'fixture.css')});fs.writeFileSync(path.join(dir,'styled.css'),css.css);
fs.writeFileSync(path.join(dir,'index.html'),`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
const env={...process.env,NEKKO_EVIDENCE_DIR:dir,NEKKO_EVIDENCE_KIND:kind};delete env.ELECTRON_RUN_AS_NODE;
const r=cp.spawnSync(require(resolve('electron')),[path.join(__dirname,'tasks-focus-evidence-electron.cjs')],{cwd:repo,env,stdio:'inherit',timeout:180000});if(r.error)throw r.error;console.log(kind,'exit',r.status);
for(const n of fs.readdirSync(dir))if(n.startsWith('profile-')||n==='source')fs.rmSync(path.join(dir,n),{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});

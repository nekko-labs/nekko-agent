// Before/after renderer evidence for account emails next to provider names.
// Builds one synthetic fixture against the base revision and the working tree,
// then captures it in a hidden, non-focusable, off-screen Electron window with
// its own profile and every non-local request cancelled.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'.shots/account-email'),base=process.env.EVIDENCE_BASE||'HEAD';
const resolve=x=>require.resolve(x,{paths:[path.join(repo,'apps/desktop'),repo]});
(async()=>{fs.rmSync(out,{recursive:true,force:true});for(const kind of ['before','after']){
const dir=path.join(out,kind);fs.mkdirSync(dir,{recursive:true});let entry=path.join(__dirname,'account-email-evidence-fixture.tsx'),shared=path.join(repo,'packages/shared/src/index.ts');
if(kind==='before'){const source=path.join(dir,'source');const paths=cp.execFileSync('git',['ls-tree','-r','--name-only',base,'apps/desktop/src/renderer','packages/shared/src'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim().split('\n');for(const p of paths){const dest=path.join(source,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,cp.execFileSync('git',['show',`${base}:${p}`],{cwd:repo,maxBuffer:20e6,windowsHide:true}));}
entry=path.join(dir,'fixture.tsx');fs.writeFileSync(entry,fs.readFileSync(path.join(__dirname,'account-email-evidence-fixture.tsx'),'utf8').replaceAll('../apps/desktop/src/renderer',path.join(source,'apps/desktop/src/renderer').replaceAll('\\','/')));shared=path.join(source,'packages/shared/src/index.ts');}
const modules=path.resolve(path.dirname(resolve('esbuild')),'../..');
await require(resolve('esbuild')).build({entryPoints:[entry],bundle:true,jsx:'automatic',conditions:['style','browser','import','default'],format:'iife',outfile:path.join(dir,'fixture.js'),nodePaths:[modules],alias:{'@nekko-agent/shared':shared},loader:{'.woff2':'dataurl','.svg':'dataurl','.png':'dataurl','.wasm':'file'},logLevel:'error'});
const css=await require(resolve('postcss'))([require(resolve('@tailwindcss/postcss'))({base:repo})]).process(fs.readFileSync(path.join(dir,'fixture.css'),'utf8'),{from:path.join(dir,'fixture.css')});fs.writeFileSync(path.join(dir,'styled.css'),css.css);
fs.writeFileSync(path.join(dir,'index.html'),`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
const env={...process.env,NEKKO_EVIDENCE_DIR:dir,NEKKO_EVIDENCE_KIND:kind};delete env.ELECTRON_RUN_AS_NODE;
const r=cp.spawnSync(require(resolve('electron')),[path.join(__dirname,'account-email-evidence-electron.cjs')],{cwd:repo,env,windowsHide:true,stdio:'inherit',timeout:120000});if(r.error)throw r.error;console.log(kind,'exit',r.status);
for(const name of fs.readdirSync(dir))if(name.startsWith('profile-')||name==='source')fs.rmSync(path.join(dir,name),{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});

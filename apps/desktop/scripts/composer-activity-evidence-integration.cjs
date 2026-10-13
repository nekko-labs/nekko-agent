// Only scripts and .shots are written. Never launches the normal application.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const repo=path.resolve(__dirname,'../../..'), modules=path.resolve(repo,'../../node_modules');
const out=path.join(repo,'.shots/composer-activity-'+Date.now());fs.mkdirSync(out,{recursive:true});
async function main(){
 const source=path.join(out,'base-source'),zip=path.join(out,'base.zip');
 cp.execFileSync('git',['archive','--format=zip','--output='+zip,'b69a311e','apps/desktop/src/renderer','packages/shared/src'],{cwd:repo,windowsHide:true});
 cp.execFileSync('powershell',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zip}','${source}')`],{windowsHide:true});
 fs.writeFileSync(path.join(out,'provenance.json'),JSON.stringify({base:cp.execFileSync('git',['rev-parse','b69a311e'],{cwd:repo,windowsHide:true}).toString().trim(),after:cp.execFileSync('git',['diff','--stat'],{cwd:repo,windowsHide:true}).toString(),modules},null,2));
 for(const kind of ['before','after']){
  const dir=path.join(out,kind);fs.mkdirSync(dir,{recursive:true});
  const renderer=path.join(kind==='before'?source:repo,'apps/desktop/src/renderer');
  const entry=path.join(dir,'fixture.tsx');fs.writeFileSync(entry,fs.readFileSync(path.join(__dirname,'composer-activity-evidence-fixture.tsx'),'utf8').replaceAll('../src/renderer',renderer.replaceAll('\\','/')));
  await require(path.join(modules,'esbuild')).build({entryPoints:[entry],bundle:true,jsx:'automatic',conditions:['style','browser','import','default'],mainFields:['browser','module','main'],format:'iife',outfile:path.join(dir,'fixture.js'),nodePaths:[modules],alias:{'@nekko-agent/shared':path.join(kind==='before'?source:repo,'packages/shared/src/index.ts'),react:path.join(modules,'react'),'react-dom/server':path.join(modules,'react-dom/server.browser.js'),'react-dom':path.join(modules,'react-dom')},loader:{'.woff2':'dataurl','.svg':'dataurl','.png':'dataurl','.wasm':'file'}});
  const css=await require(path.join(modules,'postcss'))([require(path.join(modules,'@tailwindcss/postcss/dist/index.js'))({base:repo})]).process(fs.readFileSync(path.join(dir,'fixture.css'),'utf8'),{from:path.join(dir,'fixture.css')});fs.writeFileSync(path.join(dir,'styled.css'),css.css);
  fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="styled.css"></head><body style="margin:0"><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env={...process.env,NEKKO_EVIDENCE_DIR:dir,NEKKO_EVIDENCE_KIND:kind};delete env.ELECTRON_RUN_AS_NODE;
  const result=cp.spawnSync(require(path.join(modules,'electron')),[path.join(__dirname,'composer-activity-evidence-sandbox.cjs')],{cwd:repo,env,windowsHide:true,stdio:'inherit',timeout:240000});
  for(const name of fs.readdirSync(dir))if(name.startsWith('profile-'))fs.rmSync(path.join(dir,name),{recursive:true,force:true,maxRetries:10,retryDelay:300});
  if(result.error)throw result.error;if(result.status!==0)throw Error(kind+' sandbox exit '+result.status);
 }
 const reports=['before','after'].map(k=>JSON.parse(fs.readFileSync(path.join(out,k,'status.json'))));
 const names=reports[1].captures.map(c=>c.name);
 let html='<!doctype html><meta charset="utf-8"><title>Composer / delegation matched evidence</title><style>body{background:#222;color:#fff;font:14px system-ui;margin:20px}section{margin:30px 0}div{display:flex;gap:12px}figure{margin:0;width:50%}img{width:100%;height:auto}pre{white-space:pre-wrap}h2{font-size:18px}</style><h1>Actual components: b69a311e / working tree</h1><p>Matching CSS viewports and synthetic data. Eager images. Hidden renderer evidence, not OS chrome. Motion GIF and representative PNG frames below. Pixel inspection is not claimed by this harness.</p>';
 for(const n of names){html+='<section><h2>'+n+'</h2><div>';for(let i=0;i<2;i++){const c=reports[i].captures.find(c=>c.name===n);html+='<figure><figcaption>'+['Before b69a311e','After working tree'][i]+'</figcaption>'+(c?'<img loading="eager" src="'+path.relative(out,c.file).replaceAll('\\','/')+'">':'Missing')+'</figure>';}html+='</div></section>';}
 for(const k of ['before','after'])if(fs.existsSync(path.join(out,k,'typing-growth.gif')))html+='<h2>'+k+' typing motion</h2><img style="width:70%" loading="eager" src="'+k+'/typing-growth.gif">';
 html+='<h2>Measured checks</h2><pre>'+JSON.stringify(reports.map(r=>({kind:r.kind,checks:r.checks,errors:r.errors,background:r.background})),null,2).replaceAll('<','&lt;')+'</pre>';
 fs.writeFileSync(path.join(out,'contact-sheet.html'),html);console.log('EVIDENCE_ROOT='+out);
}
main().catch(e=>{console.error(e);process.exitCode=1;});

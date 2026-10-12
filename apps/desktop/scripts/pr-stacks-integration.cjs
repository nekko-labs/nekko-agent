// Synthetic shared-renderer checks. No host, daemon, model or GitHub writes.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const modules = path.join(repo, 'node_modules');
const injection = `
Object.assign(bridge, {
  continuePrStack: async (sessionId, url) => {
    calls.push({method:'continueStack',sessionId,url});
    await new Promise(r=>setTimeout(r,120));
    if(window.stackFailure)throw Error('Synthetic Git authentication failure. Retry after signing in.');
    const s={...makeSession('followup-'+(++serial)),workspaceId:'synthetic-project',executionMode:'worktree',gitIsolation:true,gitStackParent:{workspaceId:'synthetic-project',url,branch:'feature/auth',sha:'a'.repeat(40)}};
    records.push(s);return s;
  },
  linkPrStack: async (sessionId,url) => {calls.push({method:'linkStack',sessionId,url});fixturePrs=fixturePrs.map(p=>({...p,stack:{number:3,size:2}}));return {ok:true,message:'Linked as a GitHub PR stack.'};},
  openPath: async url => {calls.push({method:'openPath',url});},
  prAction: async (url,action) => {calls.push({method:'prAction',url,action});return {ok:true,message:'Synthetic action.'};},
});
Object.assign(window,{stackFixture:{
  parent:()=>{records[0].gitStackParent={workspaceId:'synthetic-project',url:'https://github.com/nekko-labs/nekko-agent/pull/399',branch:'feature/auth',sha:'a'.repeat(40)};useStore.setState({sessions:records.map(summarizeSession)});},
  policy:patch=>{Object.assign(records[0],patch);useStore.setState({sessions:records.map(summarizeSession)});},
  clearStack:()=>{fixturePrs=fixturePrs.map(({stack,...p})=>p);useStore.setState({prsBySession:{existing:fixturePrs}});},
}});
`;
async function main() {
  const out = path.join(repo, '.shots', 'pr-stacks-' + Date.now());
  fs.mkdirSync(out, {recursive:true});
  console.log('Evidence: ' + out);
  const base = process.env.NEKKO_STACK_BASE || '3d0bb6e0';
  for (const kind of ['before','after']) {
    const dir = path.join(out,kind);fs.mkdirSync(dir);
    let source=repo;
    if(kind==='before') {
      source=path.join(dir,'source');fs.mkdirSync(source);
      const zip=path.join(dir,'base.zip');
      cp.execFileSync('git',['archive','--format=zip',`--output=${zip}`,base,'apps/desktop/src/renderer','packages/shared/src'],{cwd:repo,windowsHide:true});
      cp.execFileSync('tar',['-xf',zip,'-C',source],{windowsHide:true});
    }
    const entry=path.join(dir,'fixture.tsx');
    let fixture=fs.readFileSync(path.join(__dirname,'pr-divider-fixture.tsx'),'utf8').replaceAll('../src/renderer',path.join(source,'apps/desktop/src/renderer').replaceAll('\\','/'));
    fixture=fixture.replace("createRoot(document.getElementById('root')!)",injection+"\ncreateRoot(document.getElementById('root')!)");
    fs.writeFileSync(entry,fixture);
    await require(path.join(modules,'esbuild')).build({entryPoints:[entry],bundle:true,jsx:'automatic',conditions:['style','browser','import','default'],format:'iife',outfile:path.join(dir,'fixture.js'),nodePaths:[modules],alias:{'@nekko-agent/shared':path.join(source,'packages/shared/src/index.ts'),'@fixture/context':path.join(repo,'packages/core/src/context/assembler.ts')},loader:{'.woff2':'dataurl','.svg':'dataurl','.png':'dataurl','.wasm':'file'}});
    const css=await require(path.join(modules,'postcss'))([require(path.join(modules,'@tailwindcss/postcss/dist/index.js'))({base:repo})]).process(fs.readFileSync(path.join(dir,'fixture.css'),'utf8'),{from:path.join(dir,'fixture.css')});
    fs.writeFileSync(path.join(dir,'styled.css'),css.css);
    fs.writeFileSync(path.join(dir,'index.html'),`<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><link rel="stylesheet" href="styled.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    const binary=process.env.NEKKO_ELECTRON_BINARY || require(path.join(modules,'electron'));
    const env={...process.env,NEKKO_STACK_FIXTURE_DIR:dir,NEKKO_STACK_FIXTURE_KIND:kind};delete env.ELECTRON_RUN_AS_NODE;
    const result=cp.spawnSync(binary,[path.join(__dirname,'pr-stacks-sandbox.cjs')],{cwd:repo,env,windowsHide:true,stdio:'inherit',timeout:90000});
    const profile=path.resolve(dir,'profile');
    if(!profile.startsWith(path.resolve(out)+path.sep))throw Error('Profile cleanup escaped evidence directory');
    fs.rmSync(profile,{recursive:true,force:true});
    if(result.error)throw result.error;if(result.status)throw Error(kind+' renderer checks failed');
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

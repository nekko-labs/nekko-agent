// Real App, synthetic read-only bridge, hidden isolated renderer evidence.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through layout-evidence-integration.cjs');
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const strict = process.env.NEKKO_MODELS_ASSERT === '1';
const report = { captures: [], metrics: [], errors: [], assertions: [] };
const assert = (value, label) => { report.assertions.push({ label, passed: !!value }); if (!value && strict) throw Error(label); };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|devtools:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1920, height: 1000, useContentSize: true, frame: false, show: false, focusable: false, skipTaskbar: true, x: -12000, y: -12000, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message.slice(0, 400)); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const shot = async name => { const file = path.join(out, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.captures.push(file); };
  const nav = async id => {
    await run(`(() => { const ids = ['cloud','local','library','connections']; const buttons = document.querySelectorAll('[aria-label="Models sections"] button'); buttons[ids.indexOf(${js(id)})]?.click(); })()`);
    await sleep(1000);
    // Hidden windows can defer painting. Await two real compositor frames so
    // capturePage and scroll-spy assertions cannot read an earlier surface.
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  };
  fs.cpSync(path.join(__dirname, '../src/renderer/public/providers'), path.join(out, 'providers'), { recursive: true });
  try {
    await win.loadFile(path.join(out, 'index.html'));
    for (let i = 0; i < 100 && !(await run('!!window.layoutFixture')); i++) await sleep(100);
    await run(`(() => {
      const providers = [
        {id:'claude', kind:'anthropic',label:'Nekko Labs',enabled:true},
        {id:'openai',kind:'openai',label:'Personal API',enabled:true},
        {id:'gemini',kind:'gemini',label:'Google AI',enabled:true},
        {id:'router',kind:'openrouter',label:'OpenRouter',enabled:true},
        {id:'local',kind:'lmstudio',label:'LM Studio',enabled:true,baseUrl:'http://localhost:1234/v1'}
      ];
      const models = id => Array.from({length:10}, (_, i) => ({id:id+'-model-'+i,providerId:id,name:({claude:'Claude Sonnet',openai:'GPT',gemini:'Gemini',router:'Open model',local:'Local model'})[id]+' '+(i+1),contextWindow:128000}));
      Object.assign(window.nekko, {
        listProviders: async () => providers, testProvider: async () => ({ok:true}),
        listModels: async id => models(id), listModelsStatus: async id => ({models:models(id)}),
        engineCatalog: async () => [],listModelFolders:async () => [],engineModels:async () => [],engineDownloads:async () => [],
        getLimits:async () => null, getClaudeCodeStatus:async () => ({installed:false,loggedIn:false}), oauthStatus:async () => ({connected:false,state:"idle"}), runtimeFacts:async () => [], runtimeStatus:async () => null,
        engineStatus:async () => ({install:{available:[]},running:false,resident:[],loading:[],log:[],settings:{port:11500,bind:'local',autoload:[]}})
      });
      layoutFixture.settings.providers = providers;
      layoutFixture.store.setState({providers,activeModelId:'openai-model-0',view:'models'});
    })()`);
    await sleep(1600);
    for (const width of [1920, 1440, 820, 390, 360]) {
      win.setContentSize(width, 1000);
      win.webContents.enableDeviceEmulation({screenPosition:'desktop', screenSize:{width,height:1000}, viewPosition:{x:0,y:0}, viewSize:{width,height:1000},deviceScaleFactor:1,scale:1});
      await sleep(100);
      assert(await run('innerWidth') === width, 'exact viewport width ' + width);
      await nav('cloud');
      await shot('cloud-' + width);
      const metric = await run(`(() => {
        const root = document.querySelector('.models-workspace');
        const families = [...document.querySelectorAll('[data-provider-family]')].map(e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};});
        const nav = document.querySelector('[aria-label="Models sections"]');
        const r=nav.getBoundingClientRect();
        const buttons=[...nav.querySelectorAll('button')].map(e=>({text:e.textContent,y:e.getBoundingClientRect().y,height:e.getBoundingClientRect().height}));
        return {width:innerWidth,columns:families.filter(r=>Math.abs(r.y-families[0].y)<2).length,families,overflow:root.scrollWidth>root.clientWidth+1,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,nav:{x:r.x,y:r.y,width:r.width,height:r.height},buttons};
      })()`);
      report.metrics.push(metric);
      assert(!metric.overflow && !metric.pageOverflow, 'no overflow at ' + width);
      assert(metric.columns === (width === 1920 ? 3 : width === 1440 ? 2 : 1), 'responsive columns at ' + width);
      if (width >= 1440) assert(metric.nav.y > 160 && metric.nav.height < 360, 'floating centre-left navigation at ' + width);
      for (const id of ['local','library','connections']) {
        await nav(id);
        const selected = await run(`document.querySelector('[aria-label="Models sections"] [aria-current]')?.textContent`);
        const expected = {local:'Local model server',library:'Models',connections:'Connected servers'}[id];
        assert(selected === expected, id + ' navigation at ' + width);
        if ([1440,390].includes(width) && id !== 'local') await shot(id + '-' + width);
      }
    }
    win.setContentSize(1920, 1000);
    win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width:1920,height:1000},viewPosition:{x:0,y:0},viewSize:{width:1920,height:1000},deviceScaleFactor:1,scale:1});
    for (const count of [2,1]) {
      await run(`layoutFixture.store.setState({providers:layoutFixture.settings.providers.filter((p,i)=>i<${count}||p.id==='local')})`);
      await nav('cloud');
      const widths=await run(`[...document.querySelectorAll('[data-provider-family]')].map(e=>e.getBoundingClientRect().width)`);
      const contentWidth=await run(`document.querySelector('.provider-families').getBoundingClientRect().width`);
      assert(Math.abs(widths[0]*count+(count-1)*40-contentWidth)<2, 'fill available row for ' + count + ' provider families');
      if(count===2) await shot('cloud-two-1920');
    }
    await run('layoutFixture.store.setState({providers:layoutFixture.settings.providers})');
    win.setContentSize(1440, 1000);
    win.webContents.disableDeviceEmulation();
    await nav('cloud');
    await run(`document.querySelector('[data-provider-family="claude"] button').click()`);
    await sleep(200);
    assert(await run(`document.querySelector('[data-provider-setup]')?.dataset.providerSetup === 'anthropic'`), 'add Claude account keeps existing setup');
    await run(`document.querySelector('[aria-label="Close provider setup"]').click()`);
    await nav('connections');
    await run(`(() => {const root=document.querySelector('.models-workspace');root.dispatchEvent(new WheelEvent('wheel',{bubbles:true}));root.scrollTo({top:0,behavior:'instant'});})()`);
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await sleep(300);
    report.manual = await run(`(() => {const r=document.querySelector('.models-workspace');return {selected:document.querySelector('[aria-label="Models sections"] [aria-current]')?.textContent,scrollTop:r.scrollTop,height:r.clientHeight,total:r.scrollHeight,targets:[...r.querySelectorAll('[data-models-section]')].map(e=>({id:e.dataset.modelsSection,top:e.getBoundingClientRect().top})),rootTop:r.getBoundingClientRect().top};})()`);
    assert(report.manual.selected === 'Cloud providers', 'manual scrolling resumes section tracking');
    // Record the real smooth-scroll journey as hidden renderer frames.
    const modules = process.env.NEKKO_TEST_MODULES || path.join(__dirname, '../../../node_modules');
    const { PNG } = require(path.join(modules, 'pngjs'));
    const { GifWriter } = require(path.join(modules, 'omggif'));
    const frames=[];
    for (let i=0;i<20;i++) {
      if (i===0 || i===10) await run(`document.querySelectorAll('[aria-label="Models sections"] button')[${i===0?3:0}].click()`);
      await sleep(100);
      frames.push(PNG.sync.read((await win.capturePage(undefined,{stayHidden:true,stayAwake:true})).resize({width:960}).toPNG()));
    }
    const counts=new Map();
    const key=(d,i)=>(d[i]>>3)<<10|(d[i+1]>>3)<<5|(d[i+2]>>3);
    for(const f of frames) for(let i=0;i<f.data.length;i+=4){const k=key(f.data,i);counts.set(k,(counts.get(k)||0)+1);}
    const colors=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,256).map(([k])=>((k>>10)*8)<<16|(((k>>5)&31)*8)<<8|(k&31)*8);
    while(colors.length<256) colors.push(0);
    const indices=new Map([...counts.keys()].map(k=>{const rgb=[(k>>10)*8,((k>>5)&31)*8,(k&31)*8];let best=0,distance=Infinity;colors.forEach((c,i)=>{const d=(rgb[0]-(c>>16))**2+(rgb[1]-((c>>8)&255))**2+(rgb[2]-(c&255))**2;if(d<distance){distance=d;best=i;}});return [k,best];}));
    const buffer=Buffer.alloc(20*1024*1024), gif=new GifWriter(buffer,frames[0].width,frames[0].height,{palette:colors,loop:0});
    for(const f of frames){const pixels=new Uint8Array(f.width*f.height);for(let i=0;i<pixels.length;i++) pixels[i]=indices.get(key(f.data,i*4));gif.addFrame(0,0,f.width,f.height,pixels,{delay:10});}
    fs.writeFileSync(path.join(out,'navigation.gif'),buffer.subarray(0,gif.end()));
    report.background={visible:win.isVisible(),focusable:win.isFocusable(),bounds:win.getBounds()};
    assert(!win.isVisible()&&!win.isFocusable(),'verification remains hidden and nonfocusable');
  } catch(e) {report.failed=true;report.errors.push(String(e.stack||e));}
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  app.exit(report.failed?1:0);
});

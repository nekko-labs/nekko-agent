// Evidence only: preserve archived baseline actions, replace only capture transport.
// node scripts/agent-browser-evidence.mjs baseline|native output-directory
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const kind = process.argv[2];
if (!['baseline', 'native'].includes(kind) || !process.argv[3]) throw new Error('Expected baseline|native and output directory');
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'nekko-evidence-source-'));
const runner = join(root, 'scripts', `.agent-browser-evidence-${kind}.mjs`);
try {
  let sourceRoot = root;
  if (kind === 'baseline') {
    writeFileSync(join(scratch, 'base.tar'), execFileSync('git', ['archive', '4fc3cc5c', 'apps/desktop/src/main'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
    execFileSync('tar', ['-xf', join(scratch, 'base.tar'), '-C', scratch]);
    sourceRoot = scratch;
  }
  let script = readFileSync(join(root, 'scripts/agent-browser-benchmark.mjs'), 'utf8');
  script = script.replace(';\\nimport { startAgentBrowser }', ';\nimport { startAgentBrowser }');
  script = script.replace("const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');", () => `const root = ${JSON.stringify(root)}; const sourceRoot = ${JSON.stringify(sourceRoot)};`);
  // Archived base owns its original bridge, actions and adapter. Native uses the current bridge.
  script = script.replaceAll("join(root, 'apps/desktop/src/main/", "join(sourceRoot, 'apps/desktop/src/main/");
  script = script.replace("external: ['electron'],", () => `external: ['electron'], nodePaths: [${JSON.stringify(join(root, 'node_modules'))}],`);
  if (kind === 'baseline') script = script.replace('agentPlaywrightDriver.ts', 'agentBrowser.ts');
  if (kind === 'native') {
    script = script.replace("import { playwrightDriver }", "import { createNativeDriver } from ${JSON.stringify(join(root, 'apps/desktop/src/main/agentNativeDriver.ts'))};\nimport { playwrightDriver }");
    // This expression executes inside the generated runner; no path is serialized
    // through two levels of JavaScript template literals.
    script = script.replace('driver: playwrightDriver', "driver: () => createNativeDriver(join(process.cwd(), 'apps/desktop/resources/agent-browser', process.platform + '-' + process.arch, process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'))");
  }
  script = script.replace("driver: process.env.NEKKO_BENCH_DRIVER || 'playwright-baseline', revision: '4fc3cc5c'", () => `driver: '${kind}', revision: '${kind === 'baseline' ? '4fc3cc5c' : execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root,encoding:'utf8'}).trim()}'`);
  // This is not a benchmark rerun. Existing benchmark samples remain authoritative.
  script = script.replaceAll('i<20', 'i<0');
  const start = script.indexOf("    const shot = await step('screenshot'");
  const end = script.indexOf("    await step('logs'", start);
  if (start < 0 || end < 0) throw new Error('Capture marker not found');
  script = script.slice(0, start) + String.raw`
    await new Promise(r => setTimeout(r, 300));
    const state = () => owned.webContents.executeJavaScript('JSON.stringify({html:document.documentElement.outerHTML,x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth,scrollHeight:document.documentElement.scrollHeight,overflow:getComputedStyle(document.documentElement).overflow,scrollbarWidth:getComputedStyle(document.documentElement).scrollbarWidth,activeElement:document.activeElement.id,hasFocus:document.hasFocus(),devicePixelRatio})');
    const barrier = () => owned.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const beforeCapture = await state();
    const capture = async name => {
      await barrier();
      const image = await owned.webContents.capturePage(undefined, {stayHidden:true, stayAwake:true});
      const png = image.toPNG();
      writeFileSync(join(out, name), png);
      return {width:png.readUInt32BE(16), height:png.readUInt32BE(20), data:png};
    };
    const first = await capture('agent-page.png');
    const repeated = await capture('agent-page-repeat.png');
    result.screenshotFidelity = {before:JSON.parse(beforeCapture),after:JSON.parse(await state()),repeatedPixelsEqual:first.data.equals(repeated.data),dimensions:{width:first.width,height:first.height},captureRoute:'owned BrowserWindow.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}) after two animation frames',bounds:owned.getBounds(),contentBounds:owned.getContentBounds(),zoom:owned.webContents.getZoomFactor()};
    if (beforeCapture !== JSON.stringify(result.screenshotFidelity.after)) throw new Error('Capture changed page state');
    if (!result.screenshotFidelity.repeatedPixelsEqual) throw new Error('Repeated capture pixels differ');
    if (first.width !== 1359 || first.height !== 872) throw new Error('Unexpected compositor dimensions');
    result.hidden = {visible:owned.isVisible(),focused:owned.isFocused(),activations};
    if (result.hidden.visible || result.hidden.focused || activations) throw new Error('Owned window surfaced');
    await post({action:'close'});
    result.windowsAfterClose = BrowserWindow.getAllWindows().filter(w => w !== ui).length;
    if (result.windowsAfterClose) throw new Error('Owned window leaked');
    result.foreground = {unchanged:before === foreground()};
    if (!result.foreground.unchanged) throw new Error('Foreground changed');
    result.passed = true;
    return;
` + script.slice(end);
  writeFileSync(runner, script);
  execFileSync(process.execPath, [runner, resolve(process.argv[3])], {cwd:root,stdio:'inherit',env:process.env,timeout:150000});
} finally {
  rmSync(runner, {force:true});
  rmSync(scratch, {recursive:true,force:true,maxRetries:5,retryDelay:200});
}

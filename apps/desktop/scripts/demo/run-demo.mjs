// Plays a scripted demo in the real app while you screen-record it.
//
//   npm run demo -w apps/desktop -- <scene>             launch the app (presenter mode, demo profile), wait for
//                                                       Enter (start recording first), count down 3 s and play
//   npm run demo -w apps/desktop -- <scene> --attach    play in an app already started with NEKKO_DEMO_DEBUG_PORT=9333
//   npm run demo -w apps/desktop -- <scene> --dry --url http://localhost:1440/?presenter=1
//                                                       rehearse headless against the Local Web UI, saving a
//                                                       screenshot per step to scripts/demo/out/<scene>/
//
// Scenes live in scenes/<name>.mjs. The runner finds each element in the live
// page over the debugging port, glides the real Windows cursor to it and
// clicks with the real mouse, so the recorder sees genuine cursor movement.
// Typing goes to the focused field at a steady pace.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { osInput } from './os-input.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const valued = new Set(['--url', '--port', '--countdown', '--project'].map((f) => opt(f)).filter(Boolean));
const scene = args.find((a) => !a.startsWith('--') && !valued.has(a));
if (!scene) { console.error('Usage: npm run demo -w apps/desktop -- <scene> [--attach] [--dry --url <url>] [--project <dir>] [--benchmark] [--hide-speed]'); process.exit(1); }

const { default: demo } = await import(pathToFileURL(join(here, 'scenes', `${scene}.mjs`)).href);
const dry = args.includes('--dry');
const port = Number(opt('--port', 9333));
const countdown = Number(opt('--countdown', dry ? 0 : 3));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// `--benchmark` marks a run on the machine a scene's numbers were measured on;
// scenes keep speed readouts hidden without it. `--hide-speed` hides them in any scene.
const ctx = { benchmark: args.includes('--benchmark'), project: opt('--project', process.env.NEKKO_DEMO_PROJECT || defaultProject()) };

function defaultProject() {
  const candidates = [process.platform === 'win32' ? 'E:\dev\demo-bakery' : '', join(homedir(), 'demo-bakery')].filter(Boolean);
  return candidates.find((d) => existsSync(d)) ?? candidates.at(-1);
}

// Put the files back as each take expects them, before the app opens.
if (demo.prepare) { console.log('Preparing the demo project…'); await demo.prepare(ctx); }

async function connect() {
  if (dry) {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(opt('--url', 'http://localhost:1440/?presenter=1'));
    return { browser, page, app: null };
  }
  let app = null;
  if (!args.includes('--attach')) {
    app = spawn('npm', ['run', 'presenter', '--', '--demo', ...(args.includes('--reset') ? ['--reset'] : [])],
      { cwd: join(here, '..', '..'), env: { ...process.env, NEKKO_DEMO_DEBUG_PORT: String(port) }, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  for (let i = 0; ; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      for (let j = 0; j < 120; j++) {
        const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /index\.html|localhost/.test(p.url()) && !/devtools/.test(p.url()));
        if (page) return { browser, page, app };
        await sleep(500);
      }
      throw new Error('The app window never appeared.');
    } catch (e) {
      if (i > 240) throw e;
      await sleep(500);
    }
  }
}

const { browser, page, app } = await connect();
ctx.page = page;
const input = dry ? null : osInput();
if (!dry && !input) console.warn('No real-cursor driver on this platform yet: clicks go straight to the page.');
const shots = join(here, 'out', scene);
if (dry) mkdirSync(shots, { recursive: true });

/** The centre of a target in physical screen pixels. */
async function screenPoint(target) {
  const el = page.locator(target).first();
  await el.waitFor({ state: 'visible', timeout: 15000 });
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  const win = await page.evaluate(() => ({
    x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
    y: window.screenY + (window.outerHeight - window.innerHeight) - (window.outerWidth - window.innerWidth) / 2,
    dpr: window.devicePixelRatio,
  }));
  return { el, x: Math.round((win.x + box.x + box.width / 2) * win.dpr), y: Math.round((win.y + box.y + box.height / 2) * win.dpr) };
}

async function point(target, click) {
  const { el, x, y } = await screenPoint(target);
  if (input) { await input.glide(x, y, demo.glideMs ?? 700); await sleep(120); if (click) await input.click(); }
  else if (click) await el.click(); else await el.hover();
}

const run = {
  click: (s) => point(s.click, true),
  hover: (s) => point(s.hover, false),
  type: async (s) => { if (s.into) await point(s.into, true); await page.keyboard.type(s.type, { delay: s.delay ?? demo.typeDelay ?? 45 }); },
  press: (s) => page.keyboard.press(s.press),
  wait: (s) => sleep(s.wait),
  waitFor: (s) => page.locator(s.waitFor).first().waitFor({ state: 'visible', timeout: s.timeout ?? 120000 }),
  waitGone: (s) => page.locator(s.waitGone).first().waitFor({ state: 'hidden', timeout: s.timeout ?? 300000 }),
  // An escape hatch for setup that has no single click: gets { page, project, benchmark }.
  run: (s) => s.run(ctx),
  scroll: async (s) => { await point(s.scroll, false); if (input) await input.wheel(-(s.by ?? 360)); else await page.mouse.wheel(0, s.by ?? 360); },
};

/** Speed readouts: hidden unless this is the benchmark machine (see `ctx.benchmark`). */
const SPEED = demo.speedSelectors ?? [];
async function hideSpeed() {
  if (!SPEED.length || (ctx.benchmark && !args.includes('--hide-speed'))) return;
  await page.addStyleTag({ content: `${SPEED.join(', ')} { visibility: hidden !important; }` });
}

async function play(steps, label) {
  for (const [i, step] of steps.entries()) {
    const kind = Object.keys(run).find((k) => k in step);
    if (!kind) throw new Error(`${label} step ${i + 1} has no action: ${JSON.stringify(step)}`);
    if (step.only === 'benchmark' && !ctx.benchmark) { console.log(`${label} ${i + 1}/${steps.length} skipped (benchmark machine only)`); continue; }
    console.log(`${label} ${i + 1}/${steps.length} ${step.note ?? `${kind} ${String(step[kind]).slice(0, 60)}`}`);
    // `optional` steps (a first-run popup, say) are skipped when their target isn't there.
    const target = step.click ?? step.hover ?? step.scroll;
    if (step.optional && target && !(await page.locator(target).first().isVisible().catch(() => false))) { console.log('   skipped: not on screen'); continue; }
    await run[kind](step);
    await sleep(step.after ?? demo.between ?? 600);
    if (dry) await page.screenshot({ path: join(shots, `${label}-${String(i + 1).padStart(2, '0')}-${kind}.png`) });
  }
}

try {
  await page.bringToFront();
  await hideSpeed();
  // Setup runs before recording starts: open the right chat, pick the model.
  if (demo.setup?.length) await play(demo.setup, 'setup');
  // Wait for the presenter, however long the recorder takes to set up.
  if (!dry && !args.includes('--no-wait')) {
    console.log('\nThe app is ready. Start recording, then press Enter here to play.');
    await new Promise((r) => process.stdin.once('data', r));
    process.stdin.pause();
    await page.bringToFront();
  }
  for (let n = countdown; n > 0; n--) { console.log(`Starting "${demo.title}" in ${n}… start recording now.`); await sleep(1000); }
  await sleep(demo.holdStart ?? 1500);
  await play(demo.steps, 'step');
  await sleep(demo.holdEnd ?? 2000);
  console.log('Done. Stop recording.');
} finally {
  input?.close();
  if (dry) await browser.close(); else await browser.close().catch(() => {});
  if (app && args.includes('--quit')) app.kill();
}

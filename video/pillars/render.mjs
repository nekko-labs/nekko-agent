// Renders every pillar demo, dark and light, to out/: an H.264 MP4 and a JPEG
// poster each (existing MP4s are kept; delete out/ to re-render). `node render.mjs [browser-executable]`; without an argument
// Remotion uses (and on first run downloads) its own headless Chrome.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const DEMOS = { local: 225, speed: 228, privacy: 220, fleet: 205, anywhere: 205 }; // poster frame
const exe = process.argv[2];
const browser = exe ? [`--browser-executable=${exe}`] : [];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
mkdirSync('out', { recursive: true });

for (const [id, posterFrame] of Object.entries(DEMOS)) {
  for (const theme of ['dark', 'light']) {
    const comp = `Pillar-${id}-${theme}`;
    const name = `pillar-${id}${theme === 'light' ? '-light' : ''}`;
    const run = (args) => execFileSync(npx, ['remotion', ...args, ...browser, '--log=error'], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (!existsSync(`out/${name}.mp4`)) run(['render', 'src/index.tsx', comp, `out/${name}.mp4`, '--codec=h264', '--crf=24', '--pixel-format=yuv420p']);
    run(['still', 'src/index.tsx', comp, `out/${name}-poster.jpg`, `--frame=${posterFrame}`, '--image-format=jpeg', '--jpeg-quality=84']);
    console.log(`rendered ${name}`);
  }
}

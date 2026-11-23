// node render.mjs [stills|videos|all] [id-filter]
// Writes ../stills/<id>.png and ../<id>/<id>.mp4 (+ -light.mp4). Failures are logged and skipped.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'all';
const only = process.argv[3];
const src = readFileSync('src/scenes.tsx', 'utf8');
const scenes = [...src.matchAll(/id: '([^']+)', frames: (\d+), still: (\d+)/g)].map((m) => ({ id: m[1], frames: +m[2], still: +m[3] }));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const pub = ['--public-dir=../../../video/pillars/public', '--log=error'];
const run = (args) => execFileSync(npx, ['remotion', ...args, ...pub], { stdio: 'inherit', shell: process.platform === 'win32' });
mkdirSync('../stills', { recursive: true });
writeFileSync('../scenes.json', JSON.stringify(scenes, null, 2));
for (const s of scenes) {
  if (only && !s.id.startsWith(only)) continue;
  try {
    mkdirSync(`../${s.id}`, { recursive: true });
    if (mode !== 'videos') {
      run(['still', 'src/index.tsx', `${s.id}-dark`, `../stills/${s.id}.png`, `--frame=${s.still}`]);
      run(['still', 'src/index.tsx', `${s.id}-light`, `../stills/${s.id}-light.png`, `--frame=${s.still}`]);
    }
    if (mode !== 'stills') {
      for (const th of ['dark', 'light']) {
        const out = `../${s.id}/${s.id}${th === 'light' ? '-light' : ''}.mp4`;
        if (!existsSync(out)) run(['render', 'src/index.tsx', `${s.id}-${th}`, out, '--codec=h264', '--crf=24', '--pixel-format=yuv420p']);
      }
    }
    console.log(`ok ${s.id}`);
  } catch (e) {
    appendFileSync('../render-errors.log', `${s.id}: ${e.message}\n`);
    console.log(`FAILED ${s.id}`);
  }
}

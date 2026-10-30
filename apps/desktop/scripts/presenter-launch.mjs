// Launch the desktop app for screen recordings: presenter mode on (personal
// details masked outside Settings) and a fixed window size so every take is
// framed the same.
//
//   npm run presenter -w apps/desktop                 your own profile, masked
//   npm run presenter -w apps/desktop -- --demo       a separate demo profile (~/.nekko-agent-demo)
//   npm run presenter -w apps/desktop -- --demo --reset   wipe the demo profile first
//   npm run presenter -w apps/desktop -- --size 1920x1080
//
// Add `--preview` to run the built app (npm start) instead of dev.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const sizeAt = args.indexOf('--size');
const env = { ...process.env, NEKKO_PRESENTER: '1', NEKKO_WINDOW_SIZE: sizeAt >= 0 ? args[sizeAt + 1] : (process.env.NEKKO_WINDOW_SIZE || '1600x900') };

if (flag('--demo')) {
  env.NEKKO_DATA_DIR = process.env.NEKKO_DATA_DIR || join(homedir(), '.nekko-agent-demo');
  if (flag('--reset')) {
    rmSync(env.NEKKO_DATA_DIR, { recursive: true, force: true });
    console.log('Reset the demo profile.');
  }
}

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = flag('--preview') ? 'start' : 'dev';
// No paths in the log: the terminal may be on screen while recording.
console.log(`Presenter mode, window ${env.NEKKO_WINDOW_SIZE}${flag('--demo') ? ', demo profile' : ''}`);
const child = spawn('npm', ['run', script], { cwd: desktop, env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));

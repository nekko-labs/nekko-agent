// Build the engine daemon (nekkod) in release mode and stage it where
// electron-builder packs it (resources/bin -> <app>/resources/bin).
//
// `--optional` is for local runs (`npm run local`): without cargo it warns and
// exits 0, and the app runs the TS backend directly. Packaging never passes
// it, so an installer can never ship without its daemon by accident.
//
// `--dev` is for `npm run dev`: it builds the `dev-daemon` profile (no LTO,
// incremental) and stages nothing, because a development app runs the newest
// build straight out of target/ (findDaemon in engine-process.ts).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const optional = process.argv.includes('--optional');
const dev = process.argv.includes('--dev');
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';

// No shell: cargo is a real executable on every platform, and on Windows a
// shell reads the system Path rather than the PATH this process was given.
const candidates = ['cargo', join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')];
const cargo = candidates.find((candidate) => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0);
if (!cargo) {
  const msg = 'cargo not found: install Rust (https://rustup.rs) to build the engine daemon';
  if (optional) {
    console.warn(`${msg}; the app will run the TS backend without it.`);
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}

if (dev) {
  execFileSync(cargo, ['build', '--profile', 'dev-daemon', '--locked', '-p', 'nekkod'], { cwd: repo, stdio: 'inherit' });
  process.exit(0);
}

execFileSync(cargo, ['build', '--release', '--locked', '-p', 'nekkod'], { cwd: repo, stdio: 'inherit' });

const built = join(repo, 'target', 'release', exe);
if (!existsSync(built)) {
  console.error(`expected ${built} after the build`);
  process.exit(1);
}
const dest = join(here, '..', 'resources', 'bin');
mkdirSync(dest, { recursive: true });
copyFileSync(built, join(dest, exe));
console.log(`staged ${exe} -> ${join(dest, exe)}`);

// The decision-model runtime (ONNX Runtime, statically linked into nekkod) loads a few shared
// libraries from next to the executable: DirectML.dll on Windows (a newer one than the copy in
// System32), and the CUDA provider libraries on a Linux build with `--features cuda`. The
// ort-sys build script copies them into target/release; ship whichever are there.
const sidecar = /^(DirectML\.dll|(lib)?onnxruntime[^/\\]*\.(dll|so(\.\d+)*|dylib))$/;
for (const name of readdirSync(dirname(built))) {
  if (sidecar.test(name)) {
    copyFileSync(join(dirname(built), name), join(dest, name));
    console.log(`staged ${name}`);
  }
}

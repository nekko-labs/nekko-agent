// Build the engine daemon (nekkod) in release mode and stage it where
// electron-builder packs it (resources/bin -> <app>/resources/bin).
//
// The app has no engine without nekkod, so a missing cargo always fails.
// `--local` is for local runs (`npm run local`): a Visual C++ runtime that
// cannot be copied beside the daemon only warns, since this machine already
// has one. Packaging never passes it.
//
// `--dev` is for `npm run dev`: it builds the `dev-daemon` profile (no LTO,
// incremental) and stages nothing, because a development app runs the newest
// build straight out of target/ (findDaemon in engine-process.ts).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { copyVcRuntime } from '../../../scripts/vc-runtime.mjs';

const local = process.argv.includes('--local');
const dev = process.argv.includes('--dev');
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';

// No shell: cargo is a real executable on every platform, and on Windows a
// shell reads the system Path rather than the PATH this process was given.
const candidates = ['cargo', join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')];
const cargo = candidates.find((candidate) => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0);
if (!cargo) {
  console.error('cargo not found: install Rust (https://rustup.rs) to build the engine daemon');
  process.exit(1);
}

if (dev) {
  execFileSync(cargo, ['build', '--profile', 'dev-daemon', '--locked', '-p', 'nekkod', '--features', 'dev-tools'], { cwd: repo, stdio: 'inherit' });
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

// The decision-model runtime (ONNX Runtime, statically linked into nekkod) loads the CUDA
// provider libraries from next to the executable on a Linux build with `--features cuda`. The
// ort-sys build script copies them into target/release; ship whichever are there.
//
// Not DirectML.dll: nekkod delay-loads it (crates/nekkod/build.rs) and only on a machine that
// runs a decision model, from Windows itself when it is new enough or from a copy the host
// downloads then. An older staging run may have left one here; it would be packed, so clear it.
rmSync(join(dest, 'DirectML.dll'), { force: true });
const sidecar = /^(lib)?onnxruntime[^/\\]*\.(dll|so(\.\d+)*|dylib)$/;
for (const name of readdirSync(dirname(built))) {
  if (sidecar.test(name)) {
    copyFileSync(join(dirname(built), name), join(dest, name));
    console.log(`staged ${name}`);
  }
}

// The Visual C++ runtime nekkod imports, app-local, so a PC without the redistributable still
// starts it (scripts/vc-runtime.mjs). The host also copies these into llama.cpp builds.
if (process.platform === 'win32') {
  try {
    copyVcRuntime(dest);
  } catch (e) {
    if (!local) {
      console.error(e.message);
      process.exit(1);
    }
    console.warn(`${e.message}; this local build relies on the Visual C++ runtime Windows already has.`);
  }
}

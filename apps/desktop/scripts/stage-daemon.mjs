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
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
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

// Apple's on-device speech recognizer, reached through a small Swift command
// staged beside nekkod (crates/nekkod/speech/nekko-speech.swift, served by
// crates/nekkod/src/voice.rs). macOS only; without swiftc the daemon reports
// Apple speech as unsupported and dictation falls back to Nekko Voice.
function stageSpeechHelper(dirs) {
  if (process.platform !== 'darwin') return;
  const source = join(repo, 'crates', 'nekkod', 'speech', 'nekko-speech.swift');
  const out = join(dirs[0], 'nekko-speech');
  const fresh = existsSync(out) && statSync(out).mtimeMs >= statSync(source).mtimeMs;
  if (!fresh) {
    const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13`;
    const args = ['-O', '-target', target, '-framework', 'Speech', '-framework', 'AVFoundation', source, '-o', out];
    const built = spawnSync('xcrun', ['swiftc', ...args], { cwd: repo, stdio: 'inherit' });
    if (built.status !== 0) {
      console.warn('swiftc failed or is missing: Apple speech will be unavailable in this build');
      return;
    }
  }
  for (const dir of dirs.slice(1)) copyFileSync(out, join(dir, 'nekko-speech'));
  console.log(`staged nekko-speech -> ${dirs.join(', ')}`);
}

// The CI runner VM helper (crates/nekkod/vm/nekko-vm.swift, decision 0022),
// staged beside the dev daemon only. It is the only binary with the
// virtualization entitlement, so it is ad-hoc signed here on its own. Release
// packaging and signing land with the packaging task (T213/T214) together with a
// signed release dry-run; until then packaged builds carry no nekko-vm and CI
// runners report no VM support. Apple silicon only: macOS guests need it.
function stageVmHelper(dirs) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const source = join(repo, 'crates', 'nekkod', 'vm', 'nekko-vm.swift');
  const entitlements = join(repo, 'crates', 'nekkod', 'vm', 'nekko-vm.entitlements');
  const out = join(dirs[0], 'nekko-vm');
  const fresh = existsSync(out) && statSync(out).mtimeMs >= Math.max(statSync(source).mtimeMs, statSync(entitlements).mtimeMs);
  if (!fresh) {
    const args = ['-O', '-target', 'arm64-apple-macos14', '-framework', 'Virtualization', source, '-o', out];
    const built = spawnSync('xcrun', ['swiftc', ...args], { cwd: repo, stdio: 'inherit' });
    const signed = built.status === 0 && spawnSync('codesign', ['--force', '-s', '-', '--entitlements', entitlements, out], { stdio: 'inherit' }).status === 0;
    if (!signed) {
      rmSync(out, { force: true });
      console.warn('swiftc or codesign failed: CI runner VMs will be unavailable in this build');
      return;
    }
  }
  for (const dir of dirs.slice(1)) copyFileSync(out, join(dir, 'nekko-vm'));
  console.log(`staged nekko-vm -> ${dirs.join(', ')}`);
}

if (dev) {
  execFileSync(cargo, ['build', '--profile', 'dev-daemon', '--locked', '-p', 'nekkod', '--features', 'dev-tools'], { cwd: repo, stdio: 'inherit' });
  stageSpeechHelper([join(repo, 'target', 'dev-daemon')]);
  stageVmHelper([join(repo, 'target', 'dev-daemon')]);
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
stageSpeechHelper([dirname(built), dest]);

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

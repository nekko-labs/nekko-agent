// Write one npm package per platform carrying that platform's nekkod, the engine
// daemon the web edition runs behind. The `nekko-agent-web` bundle lists them as
// optionalDependencies (see bundle.mjs), so npm installs only the one whose
// `os`/`cpu` match, and the server finds it at runtime (src/nekkod.ts).
//
//   node apps/web-app-server/scripts/nekkod-packages.mjs --bins <dir> --out <dir> [--version x.y.z]
//
// <bins> holds one folder per platform, named as in PLATFORMS below
// (e.g. `linux-x64/nekkod`, `win32-x64/nekkod.exe` plus `msvcp140.dll`), which is
// how the release workflow lays out the build matrix's artifacts. A platform with
// no folder is skipped with a warning unless --require-all is passed.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * npm platform/arch → the Rust target the release workflow builds for it. No
 * Intel macOS: ONNX Runtime (ort-sys) has no prebuilt library for
 * x86_64-apple-darwin, and the desktop app ships arm64 only on macOS too.
 * Intel Macs are not a supported platform (dropped 2026-10-13); the server
 * refuses to start there (unsupportedPlatformReason).
 */
export const PLATFORMS = {
  'win32-x64': { os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-msvc', exe: 'nekkod.exe' },
  'linux-x64': { os: 'linux', cpu: 'x64', target: 'x86_64-unknown-linux-gnu', exe: 'nekkod' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', target: 'aarch64-unknown-linux-gnu', exe: 'nekkod' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', target: 'aarch64-apple-darwin', exe: 'nekkod' },
};

export const packageName = (key) => `@nekko-agent/nekkod-${key}`;

/**
 * Shared libraries loaded from beside the executable: ONNX Runtime's, and on Windows the
 * Visual C++ runtime deployed app-local (apps/desktop/scripts/stage-daemon.mjs,
 * scripts/vc-runtime.mjs). Not DirectML.dll: nekkod delay-loads that one on demand.
 */
const SIDECAR = /^((lib)?onnxruntime[^/\\]*\.(dll|so(\.\d+)*|dylib)|(msvcp140|vcruntime140)(_\w+)?\.dll)$/i;

export function writePackages({ bins, out, version, requireAll = false, log = console.log }) {
  mkdirSync(out, { recursive: true });
  const written = [];
  for (const [key, p] of Object.entries(PLATFORMS)) {
    const src = join(bins, key);
    if (!existsSync(join(src, p.exe))) {
      if (requireAll) throw new Error(`no ${p.exe} for ${key} in ${src}`);
      log(`skip ${key}: no ${join(src, p.exe)}`);
      continue;
    }
    const dir = join(out, key);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    for (const name of readdirSync(src)) {
      if (name !== p.exe && !SIDECAR.test(name)) continue;
      copyFileSync(join(src, name), join(dir, 'bin', name));
      // Artifacts lose their mode bits in transit; npm keeps what the tarball has.
      chmodSync(join(dir, 'bin', name), 0o755);
    }
    const pkg = {
      name: packageName(key),
      version,
      description: `The Nekko Agent engine daemon (nekkod) for ${p.os} ${p.cpu}. Installed by nekko-agent-web; not used on its own.`,
      license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/nekko-labs/nekko-agent.git' },
      os: [p.os],
      cpu: [p.cpu],
      files: ['bin'],
    };
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(dir, 'README.md'), `# ${pkg.name}\n\n${pkg.description}\n\nSee https://github.com/nekko-labs/nekko-agent\n`);
    written.push({ key, dir, name: pkg.name });
    log(`wrote ${pkg.name}@${version} -> ${dir}`);
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const bins = opt('bins');
  if (!bins) {
    console.error('usage: nekkod-packages.mjs --bins <dir> [--out <dir>] [--version x.y.z] [--require-all]');
    process.exit(2);
  }
  const version = opt('version') ?? JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
  writePackages({ bins: resolve(bins), out: resolve(opt('out') ?? join(here, '..', 'npm-nekkod')), version, requireAll: argv.includes('--require-all') });
}

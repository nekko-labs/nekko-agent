// The Visual C++ runtime DLLs, deployed app-local beside nekkod.exe.
//
// nekkod links the prebuilt ONNX Runtime, which is compiled against the DLL
// C runtime (/MD), so nekkod.exe imports MSVCP140.dll and VCRUNTIME140.dll and
// cannot be relinked with a static CRT. A Windows PC without the Visual C++
// Redistributable then fails to start it with "MSVCP140.dll was not found", and
// the first search result for that tells people to install Visual Studio.
// Microsoft allows these files to ship in the application's own folder
// ("app-local deployment"), so the installer carries them (about 1 MB) and
// the host copies them into downloaded llama.cpp builds that need them too.
//
//   node scripts/vc-runtime.mjs --copy <dir> [--arch x64|arm64]
//
// copies them out of the build machine's Visual Studio redist folder, which
// is the same toolset that built nekkod, so the DLLs are never older than it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What nekkod and the llama.cpp builds import, plus the STL's satellite DLLs. */
export const VC_RUNTIME_DLLS = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
  'msvcp140_atomic_wait.dll',
  'msvcp140_codecvt_ids.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
];

const VSWHERE = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');

/** Numeric compare of dotted versions, so 14.44 sorts above 14.9. */
const byVersion = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/**
 * The `Microsoft.VC14x.CRT` folder for `arch`, newest toolset first. A VS
 * developer prompt names it in VCToolsRedistDir; otherwise vswhere finds the
 * install. Null when there is no Visual Studio with the C++ tools.
 */
export function findVcRuntimeDir(arch = process.arch) {
  const roots = [];
  if (process.env.VCToolsRedistDir) roots.push(process.env.VCToolsRedistDir);
  if (existsSync(VSWHERE)) {
    try {
      const installs = execFileSync(VSWHERE, ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const install of installs) {
        const msvc = join(install, 'VC', 'Redist', 'MSVC');
        const versions = existsSync(msvc) ? readdirSync(msvc).filter((v) => /^\d+(\.\d+)+$/.test(v)).sort(byVersion).reverse() : [];
        roots.push(...versions.map((v) => join(msvc, v)));
      }
    } catch {
      // No usable vswhere answer; fall through to whatever VCToolsRedistDir gave.
    }
  }
  for (const root of roots) {
    const archDir = join(root, arch);
    if (!existsSync(archDir)) continue;
    const crt = readdirSync(archDir).find((n) => /^Microsoft\.VC\d+\.CRT$/i.test(n));
    if (crt && VC_RUNTIME_DLLS.every((dll) => existsSync(join(archDir, crt, dll)))) return join(archDir, crt);
  }
  return null;
}

/** Copy the runtime into `dest`. Throws when the build machine has no redist folder. */
export function copyVcRuntime(dest, arch = process.arch, log = console.log) {
  const src = findVcRuntimeDir(arch);
  if (!src) {
    throw new Error(`no Visual C++ ${arch} redist folder found: install the "MSVC v143 C++ build tools" workload, or run from a VS developer prompt`);
  }
  mkdirSync(dest, { recursive: true });
  for (const dll of VC_RUNTIME_DLLS) copyFileSync(join(src, dll), join(dest, dll));
  log(`staged the Visual C++ runtime from ${src}`);
  return src;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dest = opt('copy');
  if (!dest) {
    console.error('usage: vc-runtime.mjs --copy <dir> [--arch x64|arm64]');
    process.exit(2);
  }
  try {
    copyVcRuntime(dest, opt('arch') ?? process.arch);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

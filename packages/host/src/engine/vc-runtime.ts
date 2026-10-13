import { copyFile, stat } from 'fs/promises';
import { join } from 'path';

/**
 * The Visual C++ runtime, for llama.cpp and stable-diffusion.cpp on Windows.
 *
 * Their Windows builds import MSVCP140.dll and VCRUNTIME140.dll, which come
 * with the Visual C++ Redistributable rather than with Windows. On a PC
 * without it the server dies before printing a line, with the loader's
 * STATUS_DLL_NOT_FOUND as its exit code, and a search for the DLL's name
 * sends people off to install Visual Studio. The app ships the same DLLs
 * app-local beside nekkod (scripts/vc-runtime.mjs), and nekkod tells the host
 * where in NEKKOD_RUNTIME_DIR; when Windows has no copy of its own, they are
 * copied in beside the engine, where the loader looks first.
 */

/** The set scripts/vc-runtime.mjs stages; keep the two lists in step. */
export const VC_RUNTIME_DLLS = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
  'msvcp140_atomic_wait.dll',
  'msvcp140_codecvt_ids.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
];

/**
 * The ones every MSVC C++ program imports. When Windows has all three the
 * redistributable is installed and the engine uses it, so nothing is copied:
 * a copy beside the engine would shadow a newer system runtime with ours.
 */
const CORE = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

/** Microsoft's permanent link to the current x64 redistributable. */
export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

/** STATUS_DLL_NOT_FOUND, as Rust (signed) and Node (unsigned) report the exit code. */
const DLL_NOT_FOUND = /(?:-1073741515|3221225781|0xc0000135)\b/i;

/** Whether an exit message says the process could not find a DLL it imports. */
export function isMissingDllExit(message: string | null | undefined): boolean {
  return Boolean(message && DLL_NOT_FOUND.test(message));
}

/** What to tell a person whose engine died that way. */
export function missingDllMessage(what = 'The model server'): string {
  return `${what} couldn't start because Windows is missing the Microsoft Visual C++ Runtime. Reinstall Nekko Agent, or install the runtime from ${VC_REDIST_URL} (a 25 MB installer from Microsoft; you do not need Visual Studio).`;
}

const exists = (path: string) => stat(path).then((s) => s.isFile(), () => false);

export interface VcRuntimeOptions {
  platform?: NodeJS.Platform;
  /** Where the app-local copies are; defaults to NEKKOD_RUNTIME_DIR. */
  runtimeDir?: string;
  /** Windows' own System32; defaults to %SystemRoot%\System32. */
  systemDir?: string;
}

/**
 * Copy the runtime in beside an engine binary when Windows lacks it. Returns
 * the files copied (none when nothing was needed or there is nothing to copy
 * from, which leaves the engine as it was). Cheap enough to run before every
 * start, which is also what repairs engines installed before this existed.
 */
export async function ensureVcRuntime(binDir: string, opts: VcRuntimeOptions = {}): Promise<string[]> {
  if ((opts.platform ?? process.platform) !== 'win32') return [];
  const systemDir = opts.systemDir ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const installed = await Promise.all(CORE.map((dll) => exists(join(systemDir, dll))));
  if (installed.every(Boolean)) return [];
  const runtimeDir = opts.runtimeDir ?? process.env.NEKKOD_RUNTIME_DIR;
  if (!runtimeDir) return [];
  const copied: string[] = [];
  for (const dll of VC_RUNTIME_DLLS) {
    if (await exists(join(binDir, dll))) continue;
    if (!(await exists(join(runtimeDir, dll)))) continue;
    await copyFile(join(runtimeDir, dll), join(binDir, dll));
    copied.push(dll);
  }
  return copied;
}

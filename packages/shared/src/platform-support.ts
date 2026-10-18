/**
 * Where Nekko Agent runs its engine. The engine is the daemon (nekkod), with
 * no in-process fallback since 2026-10-18, so a platform is supported exactly
 * when there is a nekkod build for it: Apple silicon, Windows x64, Linux x64
 * and arm64. Windows on Arm runs the x64 build under the emulation Windows 11
 * ships. Intel Macs were dropped on 2026-10-13 (ONNX Runtime has no prebuilt
 * library for x86_64-apple-darwin); they can come back if there is demand.
 */
const SUPPORTED: Record<string, string[]> = {
  darwin: ['arm64'],
  win32: ['x64', 'arm64'],
  linux: ['x64', 'arm64'],
};

/** Why this machine cannot run the engine, or null when it can. */
export function unsupportedPlatformReason(platform: string, arch: string): string | null {
  if (SUPPORTED[platform]?.includes(arch)) return null;
  const elsewhere = 'From here you can still connect to Nekko Agent running on another machine (for example `nekko-agent --url <address>`).';
  if (platform === 'darwin') {
    return `Nekko Agent needs a Mac with Apple silicon (M1 or later); Intel Macs are not supported. ${elsewhere}`;
  }
  return `Nekko Agent's engine has no build for ${platform} ${arch}; it runs on Windows, Linux (x64 or arm64) and Apple silicon Macs. ${elsewhere}`;
}

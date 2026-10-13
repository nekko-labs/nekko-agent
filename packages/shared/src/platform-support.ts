/**
 * Where Nekko Agent runs its engine. Intel Macs were dropped on 2026-10-13:
 * the engine daemon (nekkod) cannot be built for them (ONNX Runtime has no
 * prebuilt library for x86_64-apple-darwin), the desktop app already shipped
 * arm64 only on macOS, and keeping the in-process TypeScript engine alive for
 * them alone would block retiring it. They can come back if there is demand.
 */
export function unsupportedPlatformReason(platform: string, arch: string): string | null {
  if (platform === 'darwin' && arch !== 'arm64') {
    return 'Nekko Agent needs a Mac with Apple silicon (M1 or later); Intel Macs are not supported. '
      + 'From an Intel Mac you can still connect to Nekko Agent running on another machine (for example `nekko-agent --url <address>`).';
  }
  return null;
}

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Where the app's own icon lives, for the window and taskbar button, the tray
 * and toast notifications. A packaged app has it in the built renderer.
 *
 * An unpackaged run reads the source asset first. `electron-vite dev` rebuilds
 * `out/main` and `out/preload` but serves the renderer from Vite, so
 * `out/renderer/` is whatever an earlier full build left there: after a logo
 * change it still holds the old icon, and the tray and taskbar kept showing it.
 */
export function appIconCandidates(mainDir: string, packaged: boolean): string[] {
  const built = [join(mainDir, '../renderer/icon-512.png'), join(mainDir, '../renderer/public/icon-512.png')];
  const source = join(mainDir, '../../src/renderer/public/icon-512.png');
  return packaged ? [...built, source] : [source, ...built];
}

export function resolveAppIcon(mainDir: string, packaged: boolean, exists: (path: string) => boolean = existsSync): string | undefined {
  return appIconCandidates(mainDir, packaged).find((path) => exists(path));
}

import { app } from 'electron';

/**
 * Electron decides `app.isPackaged` from the executable's file name, so the
 * branded "Nekko Agent.exe" dev runtime (scripts/dev-launch.mjs) reports a
 * packaged app. Then dev looked for an installed updater manifest, a bundled
 * daemon and the installed profile. `process.defaultApp` is only set when the
 * runtime was started with an app path, which a real install never is.
 * Imported first by index.ts so nothing reads the wrong value.
 */
export function correctDevPackaging(target: { isPackaged: boolean } = app, defaultApp = process.defaultApp): void {
  if (defaultApp && target.isPackaged) Object.defineProperty(target, 'isPackaged', { value: false, configurable: true });
}

if (app) correctDevPackaging();

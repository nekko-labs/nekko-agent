/**
 * The branded Windows dev runtime's own app (scripts/dev-launch.mjs copies this
 * to <runtime>/resources/app/index.cjs).
 *
 * Windows starts that runtime with no app path whenever it launches it on its
 * own: clicking a notification once the process that posted it is gone (the
 * toast activator is registered against the bare executable), or the Start
 * Menu entry Electron writes for it. Stock Electron answers a bare launch with
 * its empty "default app" window. Here a bare launch reopens Nekko Agent from
 * this checkout instead; the single-instance lock hands it to the dev app that
 * is already running. Launches that name an app (the dev server's own) go to
 * Electron's default app loader exactly as before.
 */
const { app } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { appDir } = require('./target.json');

/** Mirrors Electron's default app: does this command line name something to run? */
function namesApp(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--require' || arg === '-r') { i++; continue; }
    if (!arg.startsWith('-') || arg.startsWith('--app=')) return true;
    if (['-v', '--version', '-i', '--interactive', '-repl', '-a', '--abi'].includes(arg)) return true;
  }
  return false;
}

if (namesApp(process.argv.slice(1))) {
  import(pathToFileURL(join(process.resourcesPath, 'default_app.asar', 'main.js')).href);
} else {
  spawn(process.execPath, [appDir], { cwd: appDir, detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
}

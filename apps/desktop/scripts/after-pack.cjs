// electron-builder afterPack hook.
//
// Ad-hoc signing is the *fallback* for unsigned builds. An unsigned arm64 app
// won't launch at all ("app is damaged"), so a local `npm run dist` with no
// certificate still needs a signature of some kind to be testable.
//
// When a real Developer ID certificate is present (CSC_LINK, set by the
// release workflow from the org signing secrets), electron-builder does the
// signing itself — properly, with the hardened runtime and entitlements, and
// then notarizes. Ad-hoc signing here would just be overwritten, and `--deep`
// is the wrong tool besides, so skip it.
//
// No-op on Windows/Linux.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[after-pack] Developer ID cert present, leaving signing to electron-builder');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  try {
    execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log(`[after-pack] ad-hoc signed ${appName} (unsigned build)`);
  } catch (e) {
    console.warn(`[after-pack] ad-hoc signing failed (continuing): ${e.message}`);
  }
};

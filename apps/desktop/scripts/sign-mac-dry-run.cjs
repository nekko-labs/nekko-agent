// Usage: node apps/desktop/scripts/sign-mac-dry-run.cjs <path to a copy of Nekko Agent.app>
//
// Runs the release mac.sign hook (sign-mac.cjs: osx-sign and codesign) with an
// ad-hoc identity in place of the Developer ID, then checks the result the way
// a release does: a strict deep verify, only nekko-vm with the virtualization
// entitlement, no restricted entitlement outside the main executable, and
// nekko-vm still starting. Like electron-builder, the main executable gets
// entitlements.mac.plist and everything else entitlements.mac.inherit.plist. No
// provisioning profile, and none picked up from this Mac's library: an ad-hoc
// main executable with restricted entitlements would not launch, and this
// never launches it. Any failure exits non-zero. It
// re-signs the app in place, so give it a copy. See docs/signing.md.
const { execFileSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const sign = require('./sign-mac.cjs').default;

async function main() {
  const app = process.argv[2] && resolve(process.argv[2]);
  if (!app) throw new Error('usage: sign-mac-dry-run.cjs <app>');
  const build = join(__dirname, '..', 'build');
  const entitlements = (file) => join(build, file === app ? 'entitlements.mac.plist' : 'entitlements.mac.inherit.plist');
  await sign({ app, platform: 'darwin', identity: '-', identityValidation: false, preEmbedProvisioningProfile: false, optionsForFile: (file) => ({ hardenedRuntime: true, entitlements: entitlements(file) }) });
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  run('codesign', ['--verify', '--deep', '--strict', app]);
  process.stdout.write(run(join(__dirname, '..', '..', '..', 'scripts', 'check-mac-entitlements.sh'), [app]));
  // count-vms prints {"count":N}; nekko-vm must start under the new signature.
  const out = run(join(app, 'Contents', 'Resources', 'bin', 'nekko-vm'), ['count-vms']).trim();
  let count;
  try { count = JSON.parse(out).count; } catch {}
  if (!Number.isInteger(count)) throw new Error(`nekko-vm count-vms printed ${JSON.stringify(out)}, not {"count":N}`);
  console.log(`signed dry-run OK: nekko-vm count-vms ${out}`);
}

main().catch((e) => {
  console.error(`signed dry-run failed: ${e.message}`);
  process.exit(1);
});

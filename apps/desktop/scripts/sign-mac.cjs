// electron-builder mac.sign hook: the stock @electron/osx-sign run, except that
// nekko-vm (the CI runner VM helper staged in resources/bin) is signed with its
// own entitlements file. It is the only binary allowed to create VMs, so the
// virtualization entitlement never goes in build/entitlements.mac*.plist, which
// the app, its helpers and nekkod are signed with. It also refuses to sign
// without the provisioning profile electron-builder.yml names: the main
// executable's entitlements are restricted, and macOS refuses to launch the
// app unless that profile is embedded (#2688). Notarization still runs after
// this, in electron-builder.
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const vmEntitlements = join(__dirname, '..', '..', '..', 'crates', 'nekkod', 'vm', 'nekko-vm.entitlements');

const withVmEntitlements = (base) => (file) =>
  file.endsWith('/Contents/Resources/bin/nekko-vm') ? { ...base(file), entitlements: vmEntitlements } : base(file);

/** The profile as an absolute path (electron-builder passes the yml's, relative to apps/desktop), or undefined when none is set. Throws when it is set but missing. */
function resolveProvisioningProfile(profile, root = join(__dirname, '..')) {
  if (!profile) return undefined;
  const path = resolve(root, profile);
  if (!existsSync(path)) {
    throw new Error(`Provisioning profile ${path} not found. A signed macOS build needs it, or the app will not launch: docs/signing.md, "Provisioning profile".`);
  }
  return path;
}

exports.default = async function sign(opts) {
  const provisioningProfile = resolveProvisioningProfile(opts.provisioningProfile);

  // app-builder-lib's own wrapper: the osx-sign version electron-builder pins,
  // with its retry for flaky timestamp servers. Required here, not at the top:
  // after-pack.cjs loads this file on every platform.
  const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');
  return sign({ ...opts, provisioningProfile, optionsForFile: withVmEntitlements(opts.optionsForFile) });
};
exports.vmEntitlements = vmEntitlements;
exports.withVmEntitlements = withVmEntitlements;
exports.resolveProvisioningProfile = resolveProvisioningProfile;

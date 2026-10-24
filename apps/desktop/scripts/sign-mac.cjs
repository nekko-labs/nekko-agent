// electron-builder mac.sign hook: the stock @electron/osx-sign run, except that
// nekko-vm (the CI runner VM helper staged in resources/bin) is signed with its
// own entitlements file. It is the only binary allowed to create VMs, so the
// virtualization entitlement never goes in build/entitlements.mac.plist, which
// the app, its helpers and nekkod all inherit. Notarization still runs after
// this, in electron-builder.
const { join } = require('node:path');

const vmEntitlements = join(__dirname, '..', '..', '..', 'crates', 'nekkod', 'vm', 'nekko-vm.entitlements');

exports.default = async function sign(opts) {
  // app-builder-lib's own wrapper: the osx-sign version electron-builder pins,
  // with its retry for flaky timestamp servers. Required here, not at the top:
  // after-pack.cjs loads this file on every platform.
  const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');
  const base = opts.optionsForFile;
  return sign({
    ...opts,
    optionsForFile: (file) =>
      file.endsWith('/Contents/Resources/bin/nekko-vm') ? { ...base(file), entitlements: vmEntitlements } : base(file),
  });
};
exports.vmEntitlements = vmEntitlements;

// Evidence-only overlay, applied identically to both pinned app revisions.
// Never included by the ordinary native build or a production release.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function permissionReturnFixture(appModel, app) {
  const modelNeedle = 'if args.contains("-uiTestNotificationStep") { showNotificationStep = true }';
  const routeNeedle = '        let flags = ["-uiTestPermissionsSettings", "-uiTestNotificationStep",';
  for (const [text, needle] of [[appModel, modelNeedle], [app, routeNeedle]]) {
    if (text.split(needle).length !== 2) throw new Error(`Expected one fixture anchor: ${needle}`);
  }
  if (app.includes('enum PermissionReturnEvidenceRoute')) throw new Error('Fixture already overlaid');
  return {
    appModel: appModel.replace(modelNeedle,
      'if args.contains("-uiTestNotificationStep") || PermissionReturnEvidenceRoute.active { showNotificationStep = true }'),
    app: app.replace(routeNeedle,
      '        if PermissionReturnEvidenceRoute.active { return true }\n' + routeNeedle) + `

#if DEBUG
/// Only the disposable permission-return evidence simulator sets this marker.
/// iOS TCC kills the app after the real Settings toggle; its replacement process
/// receives no test arguments. Preserve the route, never an authorization value.
enum PermissionReturnEvidenceRoute {
    static let active: Bool = {
        let defaults = UserDefaults.standard
        let key = "permissionReturnEvidenceRoute"
        if ProcessInfo.processInfo.arguments.contains("-uiTestPermissionReturnEvidence") {
            defaults.set(true, forKey: key)
            // Preserve the same fixture UI configuration used on initial launch.
            // These are app-owned test preferences, not OS permission values.
            defaults.set(false, forKey: "appLock")
            defaults.set("light", forKey: "theme")
        }
        return defaults.bool(forKey: key)
    }()
}
#endif
`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || '.';
  const modelFile = path.join(root, 'apps/ios/App/AppModel.swift');
  const appFile = path.join(root, 'apps/ios/App/NekkoApp.swift');
  const result = permissionReturnFixture(fs.readFileSync(modelFile, 'utf8'), fs.readFileSync(appFile, 'utf8'));
  fs.writeFileSync(modelFile, result.appModel);
  fs.writeFileSync(appFile, result.app);
  console.log('Applied common DEBUG permission-return route overlay; real authorization providers unchanged.');
}

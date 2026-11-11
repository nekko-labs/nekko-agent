// Evidence-only overlay, applied identically to both pinned app revisions.
// Never included by the ordinary native build or a production release.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


// Observe real async phases on both revisions; no completion, provider or value is changed.
export function permissionReturnDiagnosticChecklist(source) {
  const once = (needle, replacement) => {
    if (source.split(needle).length !== 2) throw Error(`Expected one diagnostic anchor: ${needle}`);
    source = source.replace(needle, replacement);
  };
  if (source.includes('NEKKO_PERMISSION_RETURN')) throw Error('Diagnostics already overlaid');
  const phase = name => `        #if DEBUG\n        if PermissionReturnEvidenceRoute.active {\n            NSLog("NEKKO_PERMISSION_RETURN phase=${name} uptime=%.6f pid=%d",\n                  ProcessInfo.processInfo.systemUptime, ProcessInfo.processInfo.processIdentifier)\n        }\n        #endif\n`;
  once('    func refresh() async {\n', '    func refresh() async {\n' + phase('refresh.begin'));
  const settings = '        let settings = await UNUserNotificationCenter.current().notificationSettings()\n';
  once(settings, settings + phase('refresh.notificationSettings.complete'));
  once('    }\n\n    static func capture(', phase('refresh.complete') + '    }\n\n    static func capture(');
  once('        case .microphone: _ = await AVAudioApplication.requestRecordPermission()\n',
    '        case .microphone:\n' + phase('request.microphone.begin') +
    '            _ = await AVAudioApplication.requestRecordPermission()\n' + phase('request.microphone.complete'));
  once('        await refresh()\n    }\n\n    func stop()', phase('request.refresh.begin') +
    '        await refresh()\n' + phase('request.refresh.complete') + '    }\n\n    func stop()');
  return source;
}

export function permissionReturnFixture(appModel, app, checklist) {
  const modelNeedle = 'if args.contains("-uiTestNotificationStep") { showNotificationStep = true }';
  const routeNeedle = '        let flags = ["-uiTestPermissionsSettings", "-uiTestNotificationStep",';
  for (const [text, needle] of [[appModel, modelNeedle], [app, routeNeedle]]) {
    if (text.split(needle).length !== 2) throw new Error(`Expected one fixture anchor: ${needle}`);
  }
  if (app.includes('enum PermissionReturnEvidenceRoute')) throw new Error('Fixture already overlaid');
  return {
    checklist: permissionReturnDiagnosticChecklist(checklist),
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
  const checklistFile = path.join(root, 'apps/ios/App/Platform/PermissionChecklist.swift');
  const result = permissionReturnFixture(fs.readFileSync(modelFile, 'utf8'), fs.readFileSync(appFile, 'utf8'), fs.readFileSync(checklistFile, 'utf8'));
  fs.writeFileSync(checklistFile, result.checklist);
  fs.writeFileSync(modelFile, result.appModel);
  fs.writeFileSync(appFile, result.app);
  console.log('Applied common DEBUG permission-return route overlay; DEBUG phase diagnostics added; real authorization providers unchanged.');
}

// Diagnostic-only callback logging, applied identically in disposable CI checkouts.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const traceEdits = [
  ['    private var tuck: some Gesture {\n        DragGesture(minimumDistance: 16)', '    private var tuck: some Gesture {\n        DragGesture(minimumDistance: 16)\n            .onChanged { v in pillGestureTrace("tuck.changed translation=\\(v.translation) lifted=\\(lifted) placement=\\(prefs.pillPlacement.encoded)") }'],
  ['            .onEnded { v in\n                if !lifted && prefs.pillPlacement.swipesIn', '            .onEnded { v in\n                pillGestureTrace("tuck.ended translation=\\(v.translation) predicted=\\(v.predictedEndTranslation) lifted=\\(lifted) placement=\\(prefs.pillPlacement.encoded)")\n                if !lifted && prefs.pillPlacement.swipesIn'],
  ['    private func setTucked(_ tucked: Bool) {', '    private func setTucked(_ tucked: Bool) {\n        pillGestureTrace("setTucked value=\\(tucked) placement=\\(prefs.pillPlacement.encoded)")'],
  ['            .onChanged { value in\n                guard case .second(true, let drag) = value else { return }', '            .onChanged { value in\n                pillGestureTrace("move.changed value=\\(String(describing: value)) lifted=\\(lifted)")\n                guard case .second(true, let drag) = value else { return }'],
  ['            .onEnded { value in\n                if case .second(true, let drag?) = value {', '            .onEnded { value in\n                pillGestureTrace("move.ended value=\\(String(describing: value)) lifted=\\(lifted)")\n                if case .second(true, let drag?) = value {'],
  ['    private func open() {\n        guard monitor != nil else { return }', '    private func open() {\n        pillGestureTrace("open lifted=\\(lifted) placement=\\(prefs.pillPlacement.encoded)")\n        guard monitor != nil else { return }'],
];
export const traceHelper = `
// Read-only diagnostic callback trace. Never applied to a shipping checkout.
private func pillGestureTrace(_ event: String) {
    #if DEBUG
    guard ProcessInfo.processInfo.arguments.contains("-uiTestPillHardware") else { return }
    NSLog("%@", "NEKKO_PILL_TRACE \\(event)")
    #endif
}
`;
export function withPillGestureTrace(source) {
  for (const [before, after] of traceEdits) {
    if (source.split(before).length !== 2) throw new Error(`Nonunique trace anchor: ${before}`);
    source = source.replace(before, after);
  }
  return source + traceHelper;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = 'apps/ios/App/Views/AgentPill.swift';
  fs.writeFileSync(file, withPillGestureTrace(fs.readFileSync(file, 'utf8')));
}

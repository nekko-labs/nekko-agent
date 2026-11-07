import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const flag = '"-uiTestComputerSettingsEvidence"';
const route = `if ProcessInfo.processInfo.arguments.contains(${flag}) { ComputerSettingsEvidenceFixture() } else`;
const anchor = 'if ProcessInfo.processInfo.arguments.contains("-uiTestVoiceConversation") { VoiceConversationFixture() } else';

// Only add fixture routing. Never replace the baseline's production app sources.
export function overlayComputerSettings(source) {
  const arrays = [...source.matchAll(/let flags = \[([^\]]*)\]/g)];
  if (arrays.length !== 1) throw new Error('Baseline isolation flags changed');
  const flags = arrays[0][1];
  const flagCount = flags.split(flag).length - 1;
  const routeCount = source.split(route).length - 1;
  if (flagCount > 1 || routeCount > 1) throw new Error('Ambiguous computer settings fixture');
  if (!routeCount && source.split(anchor).length !== 2) throw new Error('Baseline routing changed');
  if (!flagCount) {
    source = source.replace(arrays[0][0], `let flags = [${flag}, ${flags}]`);
  }
  if (!routeCount) source = source.replace(anchor, `${route}\n        ${anchor}`);
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = 'apps/ios/App/NekkoApp.swift';
  fs.writeFileSync(file, overlayComputerSettings(fs.readFileSync(file, 'utf8')));
}

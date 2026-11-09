import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Evidence-only input: the same three real protocol dial fields on both app revisions. */
export function withPillHardwareFixture(source) {
  const needle = '    public func refresh() async {\n';
  if (source.split(needle).length !== 2 || source.includes('-uiTestPillHardware')) {
    throw new Error('Expected one unmodified monitor refresh entry point');
  }
  return source.replace(needle, needle + `        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestPillHardware") {
            system = SystemStats.from(["cpuPct": 12, "memUsedMB": 1024, "memTotalMB": 4096])
            gpu = GpuStats.from(["totalMB": 8192, "usedMB": 2048, "devices": [["name": "Fixture RTX", "utilizationPct": 40]]])
            engine = stubEngine
            error = nil
            loaded = true
            return
        }
        #endif
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = 'apps/ios/Protocol/Sources/NekkoKit/HardwareMonitorModel.swift';
  fs.writeFileSync(target, withPillHardwareFixture(fs.readFileSync(target, 'utf8')));
}

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';

const fixtures = JSON.parse(readFileSync(join(__dirname,
  '../../../crates/nekko-store/tests/timezone/clear-cutoffs.json'), 'utf8')) as {
  name: string; timezone: string; nowMs: number; scope: 'today' | 'month'; expectedMs: number;
}[];
const runNode = promisify(execFile);
const results = new Map<string, { zone: string; cutoff: number }>();

beforeAll(async () => {
  // Pin TZ in a fresh process per zone, without changing the test worker.
  // Cold Node/ICU startup is setup, not part of each Date assertion's deadline.
  // Async, bounded children let the runner enforce deadlines and reap a hung Node.
  for (const timezone of new Set(fixtures.map(fixture => fixture.timezone))) {
    const cases = fixtures.filter(fixture => fixture.timezone === timezone);
    const script = `
      const fixtures = ${JSON.stringify(cases)};
      console.log(JSON.stringify(fixtures.map(fixture => {
        const day = new Date(fixture.nowMs);
        day.setHours(0, 0, 0, 0);
        const month = new Date(day);
        month.setDate(1);
        return {
          name: fixture.name,
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          cutoff: (fixture.scope === 'month' ? month : day).getTime(),
        };
      })));
    `;
    const { stdout } = await runNode(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: timezone },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    for (const result of JSON.parse(stdout)) results.set(result.name, result);
  }
}, 35_000);

for (const fixture of fixtures) {
  it(`JS Date cutoff parity: ${fixture.name}`, () => {
    const result = results.get(fixture.name);
    expect(result).toBeDefined();
    expect(result!.zone).toBe(fixture.timezone);
    expect(result!.cutoff).toBe(fixture.expectedMs);
  });
}

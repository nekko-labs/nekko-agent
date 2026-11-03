import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redact } from './logRedact.js';

// The golden nekkod's `redact` is held to: both must agree line for line.
const golden = JSON.parse(readFileSync(join(__dirname, '../../../../crates/nekkod/tests/golden/log-redact.json'), 'utf8')) as { cases: [string, string][]; keep: string[] };

describe('app log redaction', () => {
  it('matches nekkod on every shared case', () => {
    for (const [input, want] of golden.cases) expect(redact(input), input).toBe(want);
  });
  it('leaves ordinary lines alone', () => {
    for (const keep of golden.keep) expect(redact(keep)).toBe(keep);
  });
});

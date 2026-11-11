import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { collectSessionPrUrls } from './pr.js';

interface Fixture {
  cases: Array<{ name: string; tool: string; command: string; output: string; isError?: boolean; expect: string[] }>;
}

// The engine's Rust copy (crates/nekko-store/src/pr.rs) runs the same cases.
const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'pr-creation.json'), 'utf8')) as Fixture;

describe('pr-creation fixture', () => {
  it.each(fixture.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const messages = [
      { role: 'assistant', toolCalls: [{ id: 'c', name: c.tool, input: { command: c.command } }] },
      { role: 'tool', toolResult: { toolCallId: 'c', output: c.output, isError: c.isError } },
    ];
    expect(collectSessionPrUrls(messages)).toEqual(c.expect);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompt.js';

const prompt = buildSystemPrompt({ platform: 'win32', workspaces: [] } as Parameters<typeof buildSystemPrompt>[0]);

describe('end-of-turn wrap-up format', () => {
  it('asks every model for the same Changes / Verified / Not verified / Next step closing', () => {
    expect(prompt).toContain('a short **Changes** list (one bullet per change, naming the files or PR touched');
    const order = ['**Changes**', '**Verified**', '**Not verified / blocked**', '**Next step**'].map((label) => prompt.indexOf(label));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain('whatever the model');
  });
  it('keeps plain replies for turns that changed nothing', () => {
    expect(prompt).toContain('Skip the structure for conversation, questions and answers, and turns that changed nothing');
  });
  it('sits right after the honest wrap-up rule and is identical in the Rust prompt', () => {
    const honest = prompt.indexOf('- End every turn with an honest wrap-up');
    const format = prompt.indexOf('- When the turn changed anything');
    expect(format).toBeGreaterThan(honest);
    expect(prompt.slice(honest, format)).not.toContain('\n\n');
    const line = prompt.slice(format, prompt.indexOf('\n', format));
    const rust = readFileSync(new URL('../../../../crates/nekko-context/src/prompt.rs', import.meta.url), 'utf8').replaceAll('\\"', '"');
    expect(rust).toContain(line);
  });
});

describe('source priority', () => {
  it('prefers folders, then connectors, then the CLI, in both prompts', () => {
    const at = (s: string) => prompt.indexOf(s);
    const line = prompt.slice(at('- Pick sources in this order'), prompt.indexOf('\n- ', at('- Pick sources in this order') + 1)).replace(/\n/g, '');
    expect(at('workspace folders (read')).toBeLessThan(at('then connected connectors'));
    expect(at('then connected connectors')).toBeLessThan(at('only then command-line tools'));
    const rust = readFileSync(new URL('../../../../crates/nekko-context/src/prompt.rs', import.meta.url), 'utf8');
    expect(rust).toContain(line);
  });
});

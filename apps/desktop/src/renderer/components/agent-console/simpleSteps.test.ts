import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityGroup } from './ActivityGroup.js';
import type { Activity } from './transcript.js';

const mode = vi.hoisted(() => ({ thinking: false }));
vi.mock('../../simpleMode.js', () => ({ useShown: () => mode.thinking }));
const tool: Activity = { kind: 'tool', call: { id: 'c', name: 'read_file', input: { path: 'README.md' } }, result: { toolCallId: 'c', output: 'Contents' } };
const thought: Activity = { kind: 'reasoning', text: 'Check the documentation first.', duration: null };
const render = (items: Activity[]) => renderToStaticMarkup(createElement(ActivityGroup, { items }));

beforeEach(() => { mode.thinking = false; });
describe('Simple activity disclosure', () => {
  it('uses the purpose summary and caret instead of a generic step count', () => {
    const html = render([thought, tool]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('▸');
    expect(html).toContain('Read guidance');
    expect(html).not.toContain('Show steps');
    expect(html).not.toContain('Took 1 step');
    expect(html).not.toContain('Check the documentation first.');
  });
  it('omits reasoning-only groups entirely', () => {
    expect(render([thought])).toBe('');
  });
  it('retains reasoning in Expert', () => {
    mode.thinking = true;
    expect(render([thought, tool])).toContain('Check the documentation first.');
  });
});

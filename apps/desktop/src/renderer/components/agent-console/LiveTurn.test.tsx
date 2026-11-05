import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const live = vi.hoisted(() => ({ run: undefined as unknown }));
vi.mock('../../liveRuns.js', () => ({ useLiveRun: () => live.run }));
vi.mock('../../paneVisibility.js', () => ({ usePaneVisible: () => true }));
vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('./ActivityGroup.js', () => ({ ActivityGroup: () => <div>Steps</div> }));
vi.mock('../PrCard.js', () => ({ PrCard: ({ url, event }: { url: string; event: string }) => <div data-pr={url}>{event}</div> }));
vi.mock('./rowState.js', () => ({ useRowState: (_key: string, value: unknown) => [value, vi.fn()] }));
import type { LiveRun } from '../../liveRuns.js';
import { LiveTurn } from './LiveTurn.js';

const run = (...texts: string[]) => ({
  tools: [{ name: 'read_file', input: {} }],
  blocks: texts.flatMap((text) => [{ kind: 'text', text }, { kind: 'activity', items: [] }]).slice(0, -1),
}) as unknown as LiveRun;
const voices = (html: string) => [...html.matchAll(/class="msg-ai"(?: data-voice="(\w+)")?/g)].map((m) => m[1]);

describe('voices in the reply being written', () => {
  beforeEach(() => { live.run = undefined; });

  it('leaves the newest text open and settles what came before it', () => {
    live.run = run('Reading the test.', 'Should I fix signup too?', 'Still working');
    expect(voices(renderToStaticMarkup(<LiveTurn sessionId="s" held={null} />))).toEqual(['working', 'attention', undefined]);
  });

  it('a held run has finished, so its last text is the reply', () => {
    expect(voices(renderToStaticMarkup(<LiveTurn sessionId="s" held={run('Reading.', 'Fixed.')} />))).toEqual(['working', 'reply']);
  });

  it('a held run with no tools matches the plain reply that replaces it', () => {
    const held = { tools: [], blocks: [{ kind: 'text', text: 'Hello.' }] } as unknown as LiveRun;
    expect(voices(renderToStaticMarkup(<LiveTurn sessionId="s" held={held} />))).toEqual([undefined]);
  });
});

describe('PR steps in the reply being written', () => {
  beforeEach(() => { live.run = undefined; });

  it('draws a confirmed step between the working steps, where the call took it', () => {
    const call = { id: 'm', name: 'Bash', input: { command: 'gh pr merge 9 --auto' } };
    live.run = {
      tools: [call],
      blocks: [{ kind: 'activity', items: [{ kind: 'tool', call }] }, { kind: 'text', text: 'Queued.' }],
      ghResults: [{ toolCallId: 'm', output: '' }],
    } as unknown as LiveRun;
    const html = renderToStaticMarkup(<LiveTurn sessionId="s" held={null} knownPrUrls={['https://github.com/o/r/pull/9']} />);
    expect(html.indexOf('Steps')).toBeLessThan(html.indexOf('merge-requested'));
    expect(html.indexOf('merge-requested')).toBeLessThan(html.indexOf('Queued.'));
  });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const live = vi.hoisted(() => ({ run: undefined as unknown }));
vi.mock('../../liveRuns.js', () => ({ useLiveRun: () => live.run }));
vi.mock('../../paneVisibility.js', () => ({ usePaneVisible: () => true }));
vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('./ActivityGroup.js', () => ({ ActivityGroup: () => <div>Steps</div> }));
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

  it('keeps lifecycle cards between live text and identical in the held handoff', () => {
    const url = 'https://github.com/o/r/pull/9';
    const create = { id: 'create', name: 'bash', input: { command: 'gh pr create --draft --fill' } };
    const queue = { id: 'queue', name: 'bash', input: { command: 'gh pr merge 9 --auto' } };
    const held = { ...run(), tools: [create, queue], blocks: [
      { kind: 'pr', toolCallId: 'create' }, { kind: 'text', text: 'Checking the change.' },
      { kind: 'pr', toolCallId: 'queue' }, { kind: 'text', text: 'Waiting for checks.' },
    ], prMessages: [
      { role: 'assistant', toolCalls: [create] }, { role: 'tool', toolResult: { toolCallId: 'create', output: url } },
      { role: 'assistant', toolCalls: [queue] }, { role: 'tool', toolResult: { toolCallId: 'queue', output: 'Added pull request o/r#9 to the merge queue' } },
    ] } as LiveRun;
    live.run = held;
    const markup = renderToStaticMarkup(<LiveTurn sessionId="s" held={null} />);
    expect(markup.indexOf('Draft PR created')).toBeLessThan(markup.indexOf('Checking the change.'));
    expect(markup.indexOf('Checking the change.')).toBeLessThan(markup.indexOf('PR queued'));
    expect(markup.indexOf('PR queued')).toBeLessThan(markup.indexOf('Waiting for checks.'));
    expect(markup).not.toContain('PR merged');
    live.run = undefined;
    expect([...renderToStaticMarkup(<LiveTurn sessionId="s" held={held} />).matchAll(/data-pr-event="([^"]+)"/g)].map((m) => m[1])).toEqual(['created-draft', 'queued']);
  });

  it('resolves a numeric live interaction from the known saved PR without inventing creation', () => {
    const call = { id: 'draft', name: 'bash', input: { command: 'gh pr ready 9 --undo' } };
    live.run = { ...run(), blocks: [{ kind: 'pr', toolCallId: 'draft' }], prMessages: [
      { role: 'assistant', toolCalls: [call] }, { role: 'tool', toolResult: { toolCallId: 'draft', output: '' } },
    ] };
    const markup = renderToStaticMarkup(<LiveTurn sessionId="s" held={null} priorPrUrls={['https://github.com/o/r/pull/9']} />);
    expect(markup).toContain('PR set to draft');
    expect(markup).not.toContain('PR created');
  });

  it('a held run has finished, so its last text is the reply', () => {
    expect(voices(renderToStaticMarkup(<LiveTurn sessionId="s" held={run('Reading.', 'Fixed.')} />))).toEqual(['working', 'reply']);
  });

  it('a held run with no tools matches the plain reply that replaces it', () => {
    const held = { tools: [], blocks: [{ kind: 'text', text: 'Hello.' }] } as unknown as LiveRun;
    expect(voices(renderToStaticMarkup(<LiveTurn sessionId="s" held={held} />))).toEqual([undefined]);
  });
});

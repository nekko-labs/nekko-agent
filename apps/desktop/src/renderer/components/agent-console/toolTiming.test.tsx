import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyLiveActivity, reduceLiveActivity } from '@nekko-agent/shared';
import { ActivityGroup } from './ActivityGroup.js';
import { isRunningTool, watchToolElapsed } from './toolProgress.js';
import type { Activity } from './transcript.js';
import { RowKeyContext, RowMemoryContext } from './rowState.js';

vi.mock('../Markdown.js', () => ({ Markdown: () => null }));
afterEach(() => vi.useRealTimers());
const tool = (id: string, endedAt?: number): Activity => ({ kind: 'tool', call: { id, name: 'read_file', input: { path: `${id}.ts` } }, startedAt: 0, endedAt });
const render = (items: Activity[], props: Partial<React.ComponentProps<typeof ActivityGroup>> = {}, memory = new Map<string, unknown>()) => renderToStaticMarkup(
  <RowMemoryContext.Provider value={memory}><RowKeyContext.Provider value="row">
    <ActivityGroup items={items} streaming {...props} />
  </RowKeyContext.Provider></RowMemoryContext.Provider>,
);

describe('tool timing and model continuation', () => {
  it('ticks against wall time and cancels, including after sleep', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const tick = vi.fn();
    const stop = watchToolElapsed(tick);
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenLastCalledWith(100);
    vi.setSystemTime(60_000);
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenLastCalledWith(60_100);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an older concurrent call and its collapsed purpose group ticking', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2500);
    const items = [tool('older'), tool('newer', 500)];
    const collapsed = render(items);
    expect(collapsed).toContain('data-running="true"');
    expect(collapsed).toContain('Running for 2.5s');
    expect(collapsed).not.toContain('data-model-activity');
    const expanded = render(items, {}, new Map([['row:purpose-1-open', true]]));
    expect(expanded.match(/data-running="true"/g)).toHaveLength(2); // group and older call
    expect(expanded).toContain('Took 0.5s');
    // A later narration block does not stop an unfinished call's clock.
    expect(render(items, { streaming: false, turnRunning: true }, new Map([['row:group-open', true]]))).toContain('Running for 2.5s');
  });

  it('freezes a completed call, removes its running mark and shows the model continuation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const html = render([tool('done', 1250)]);
    expect(html).toContain('Took 1.3s');
    expect(html).not.toContain('data-running="true"');
    expect(html).toContain('data-model-activity');
    expect(html).toContain('Tools finished. Waiting for the model');
    expect(html).not.toContain('data-public-reasoning');
    expect(render([tool('done', 1250)], { streaming: false })).not.toContain('data-model-activity');
  });

  it('shows only existing public reasoning text even when the activity group is folded', () => {
    const html = render([tool('done', 100), { kind: 'reasoning', text: 'Public summary <script>alert(1)</script>', duration: null }], {}, new Map([['row:group-open', false]]));
    expect(html).not.toContain('<ol');
    expect(html).toContain('data-public-reasoning');
    expect(html).toContain('Public summary &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('hides the model continuation when a new tool starts or the turn is held', () => {
    const items: Activity[] = [tool('done', 100), { kind: 'reasoning', text: 'Public model summary', duration: null }];
    expect(render([...items, tool('next')])).not.toContain('data-public-reasoning');
    expect(render(items, { streaming: false })).not.toContain('data-public-reasoning');
  });

  it('does not mislabel retry backoff or a paused turn as model work', () => {
    for (const paused of [false, true]) {
      const activity = reduceLiveActivity(emptyLiveActivity(0), { type: 'retry', sessionId: 's', attempt: 1, maxAttempts: 3, delayMs: 1000, reason: 'wait', paused }, 100)!;
      expect(render([tool('done', 100)], { toolActivity: activity })).not.toContain('data-model-activity');
    }
  });

  it('does not call approval waits, held tools or completed results running', () => {
    expect(isRunningTool(tool('pending'), 'pending')).toBe(false);
    expect(isRunningTool(tool('done', 0))).toBe(false);
    expect(isRunningTool({ ...tool('result'), result: { toolCallId: 'result', output: 'ok' } } as Activity)).toBe(false);
    const pending = render([tool('pending')], { pendingCallId: 'pending' });
    expect(pending).not.toContain('data-running="true"');
    expect(pending).not.toContain('data-model-activity');
    const held = render([tool('interrupted')], { streaming: false }, new Map([['row:group-open', true]]));
    expect(held).not.toContain('data-running="true"');
    expect(held).not.toContain('data-model-activity');
  });
});

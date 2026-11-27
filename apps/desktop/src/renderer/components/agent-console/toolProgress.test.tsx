import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyLiveActivity, reduceLiveActivity, type SessionSummary } from '@nekko-agent/shared';
import { quietMinutes, toolQuietSince, watchQuietMinutes } from './toolProgress.js';
import { ToolProgressChip } from './ToolProgressChip.js';
import { applyEvent, __resetLiveRuns } from '../../liveRuns.js';
import { SubagentParentContext } from './SubagentCue.js';
import { ActivityGroup } from './ActivityGroup.js';
import { RowKeyContext, RowMemoryContext } from './rowState.js';

// Tool rows do not render Markdown; keep desktop bridge imports out of this
// headless rendering test rather than installing a synthetic browser.
vi.mock('../Markdown.js', () => ({ Markdown: () => null }));

const call = { id: 'tool-1', name: 'browser', input: {} };
const activity = () => reduceLiveActivity(emptyLiveActivity(0), { type: 'tool_call', sessionId: 's', call }, 0)!;
afterEach(() => vi.useRealTimers());

describe('tool inactivity', () => {
  it('requires explicit running status and resets conservatively on any observed event', () => {
    const running = activity();
    expect(toolQuietSince(running, call.id)).toBe(0);
    const updated = reduceLiveActivity(running, { type: 'text', sessionId: 's', delta: 'Working' }, 120_000)!;
    expect(toolQuietSince(updated, call.id)).toBe(120_000);
    for (const isError of [false, true]) {
      const done = reduceLiveActivity(updated, { type: 'tool_result', sessionId: 's', result: { toolCallId: call.id, output: 'done', isError } }, 180_000)!;
      expect(toolQuietSince(done, call.id)).toBeUndefined();
    }
    expect(toolQuietSince(running, 'missing-or-capped')).toBeUndefined();
    expect(toolQuietSince(undefined, call.id)).toBeUndefined();
  });

  it('times the displayed delegation, with one quiet badge that clears on child progress', () => {
    vi.useFakeTimers();
    vi.setSystemTime(420_000);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    try {
      const spawn = { id: 'delegate', name: 'spawn_agent', input: { title: 'Review' } };
      const child = { id: 'child', spawnCallId: spawn.id, title: 'Review' } as SessionSummary;
      const parent = reduceLiveActivity(activity(), { type: 'tool_call', sessionId: 's', call: spawn }, 0)!;
      const render = (endedAt?: number) => renderToStaticMarkup(<SubagentParentContext.Provider value={[child]}>
        <ActivityGroup streaming toolActivity={parent} items={[{ kind: 'tool', call }, { kind: 'tool', call: spawn, startedAt: 0, endedAt }]} />
      </SubagentParentContext.Provider>);
      const event = { type: 'reasoning' as const, sessionId: child.id, delta: 'Working' };
      applyEvent(event, 0);
      applyEvent({ ...event, sessionId: 'unrelated' }, Date.now());
      const quiet = render();
      expect(quiet.match(/no progress for 7 min/g)).toHaveLength(1);
      expect(quiet.indexOf('7m 0s')).toBeGreaterThan(-1);
      expect(quiet.indexOf('7m 0s')).toBeLessThan(quiet.indexOf('Subagent working'));
      applyEvent(event, Date.now()); // Same headline, fresh activity.
      expect(render()).not.toContain('no progress');
      expect(render()).toContain('Running for 7m 0s');
      vi.setSystemTime(480_000);
      expect(render()).toContain('no progress for 1 min');
      applyEvent({ type: 'done', sessionId: child.id, messageId: 'done' }, Date.now());
      expect(render()).not.toContain('no progress');
      expect(render(450_000)).toContain('Took 7m 30s');
    } finally {
      __resetLiveRuns();
      vi.unstubAllGlobals();
    }
  });

  it('uses whole elapsed minutes, never negative or invalid durations', () => {
    expect(quietMinutes(0, 59_999)).toBe(0);
    expect(quietMinutes(0, 60_000)).toBe(1);
    expect(quietMinutes(0, 179_999)).toBe(2);
    expect(quietMinutes(60_000, 0)).toBe(0);
    expect(quietMinutes(NaN, 60_000)).toBe(0);
  });

  it('wakes only at minute boundaries and cancels cleanly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(15_000);
    const changed = vi.fn();
    const stop = watchQuietMinutes(0, changed);
    vi.advanceTimersByTime(44_999);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(changed.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(60_000);
    expect(changed.mock.calls).toEqual([[1], [2]]);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('recomputes wall-clock elapsed time after sleep rather than counting ticks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const changed = vi.fn();
    const stop = watchQuietMinutes(0, changed);
    vi.setSystemTime(600_000);
    vi.advanceTimersByTime(60_000);
    expect(changed).toHaveBeenCalledWith(11);
    stop();
  });

  it('renders neutral, accessible wording only after a full minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(59_999);
    expect(renderToStaticMarkup(<ToolProgressChip since={0} />)).toBe('');
    vi.setSystemTime(120_000);
    const html = renderToStaticMarkup(<ToolProgressChip since={0} />);
    expect(html).toContain('no progress for 2 min');
    expect(html).toContain('aria-label="No progress reported for 2 minutes.');
    expect(html).toContain('may be working normally');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-live');
  });

  it('shows the chip in open rows and collapsed groups, never in held or completed tools', () => {
    vi.useFakeTimers();
    vi.setSystemTime(180_000);
    const items = [{ kind: 'tool' as const, call }];
    const running = activity();
    expect(renderToStaticMarkup(<ActivityGroup items={items} streaming toolActivity={running} />)).toContain('no progress for 3 min');
    const memory = new Map<string, unknown>([['row:group-open', false]]);
    const collapsed = renderToStaticMarkup(
      <RowMemoryContext.Provider value={memory}><RowKeyContext.Provider value="row">
        <ActivityGroup items={items} streaming toolActivity={running} />
      </RowKeyContext.Provider></RowMemoryContext.Provider>,
    );
    expect(collapsed).not.toContain('<ol');
    expect(collapsed).toContain('no progress for 3 min');
    expect(renderToStaticMarkup(<ActivityGroup items={items} />)).not.toContain('no progress');
    const done = reduceLiveActivity(running, { type: 'tool_result', sessionId: 's', result: { toolCallId: call.id, output: 'done' } }, 120_000)!;
    expect(renderToStaticMarkup(<ActivityGroup items={items} streaming toolActivity={done} />)).not.toContain('no progress');
  });
});

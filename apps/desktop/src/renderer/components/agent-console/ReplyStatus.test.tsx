import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyLiveActivity } from '@nekko-agent/shared';
import { replyIconState, ReplyStatus } from './ReplyStatus.js';

describe('reply measurements', () => {
  it('keeps zero output and elapsed time visible while waiting for generation', () => {
    const html = renderToStaticMarkup(<ReplyStatus streaming status="Working" elapsed={0} tps={0} out={0} last={null} />);
    expect(html).toContain('tok/s');
    expect(html).toContain('0 total tokens');
    expect(html).toContain('0s');
  });
  it('keeps measurements alongside the completion label', () => {
    const html = renderToStaticMarkup(<ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={{ out: 120, tps: 24, secs: 9 }} done="Finished work" />);
    expect(html).toContain('Done.');
    expect(html).toContain('120 total tokens');
    expect(html).toContain('24');
    expect(html).toContain('9s');
  });
  it('shows a watch-backed idle deadline, rounding minutes and using hours above an hour', () => {
    const base = { streaming: false, status: '', elapsed: 0, tps: 0, out: 0, last: null, done: 'Finished work', now: 100000 };
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={base.now + 60_000} />)).toContain('Sleeping · will check in 1 min');
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={base.now + 61 * 60_000} />)).toContain('Sleeping · will check in 2 hours');
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={base.now + 3 * 3600_000} />)).toContain('Sleeping · will check in 3 hours');
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={base.now - 1000} />)).toContain('Sleeping · will check in 1 min');
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={null} />)).toContain('Done.');
  });
  it('puts the measurements on the line after the sleeping label', () => {
    const html = renderToStaticMarkup(<ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={1300} last={{ out: 1300, tps: 0, secs: 61 }} nextWakeAt={100000 + 13 * 60_000} now={100000} />);
    expect(html).toMatch(/<span class="basis-full" data-reply-sleeping="true">Sleeping · will check in 13 mins<\/span><span[^>]*>— tok\/s<\/span>/);
    expect(html).toContain('· 1.3k total tokens');
    expect(html).toContain('· 61s');
    const done = renderToStaticMarkup(<ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={{ out: 1, tps: 0, secs: 1 }} done="Done" />);
    expect(done).toContain('>· — tok/s');
    expect(done).not.toContain('basis-full');
  });
  it('keeps active and blocked states ahead of sleeping', () => {
    const base = { status: 'Working', elapsed: 0, tps: 0, out: 0, last: null, nextWakeAt: 200000, now: 100000 };
    const active = renderToStaticMarkup(<ReplyStatus {...base} streaming />);
    expect(active).toContain('Working');
    expect(active).not.toContain('Sleeping');
    const blocked = renderToStaticMarkup(<ReplyStatus {...base} streaming={false} blocked="Waiting for approval" done="Finished" />);
    expect(blocked).toContain('Waiting for approval');
    expect(blocked).not.toContain('Sleeping');
  });
  it('shows nothing for an idle, unmeasured chat instead of a "Reply stats" placeholder', () => {
    const html = renderToStaticMarkup(<ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={null} />);
    expect(html).toBe('');
    expect(html).not.toContain('Reply stats');
  });
  it('leaves finished numbers to the reply in the transcript once they are persisted', () => {
    const last = { out: 120, tps: 24, secs: 9 };
    expect(renderToStaticMarkup(<ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={last} done="Finished" persisted />)).toBe('');
    // Sleeping still says so, without repeating the numbers.
    const sleeping = renderToStaticMarkup(<ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={last} persisted nextWakeAt={200000} now={100000} />);
    expect(sleeping).toContain('Sleeping');
    expect(sleeping).not.toContain('total tokens');
  });
});

it('labels provisional streaming rates as estimates', () => {
  const html = renderToStaticMarkup(<ReplyStatus streaming status="Working" elapsed={2} tps={24} out={0} last={null} estimatedRate />);
  expect(html).toContain('~24');
  expect(html).toContain('Estimated tokens per second');
});

describe('reply status icon', () => {
  it.each(['bash', 'functions.bash', 'start_process', 'read_process', 'kill_process'])('shows terminal work only while %s runs', (label) => {
    const activity = emptyLiveActivity(0);
    activity.steps.push({ id: 'tool', kind: 'tool', label, detail: '', at: 0, status: 'running' });
    expect(replyIconState(activity)).toBe('terminal');
    activity.steps[0].status = 'ok';
    expect(replyIconState(activity)).toBe('thinking');
  });

  it('keeps Nekko for other tools, writing, and startup', () => {
    expect(replyIconState(undefined)).toBe('idle');
    const activity = emptyLiveActivity(0);
    expect(replyIconState(activity)).toBe('idle');
    activity.tail = 'Writing a reply';
    expect(replyIconState(activity)).toBe('idle');
    activity.thinking = 'Considering the next step';
    expect(replyIconState(activity)).toBe('thinking');
    activity.steps.push({ id: 'read', kind: 'tool', label: 'read_file', detail: '', at: 0, status: 'running' });
    expect(replyIconState(activity)).toBe('idle');
  });

  it.each(['thinking', 'terminal'] as const)('renders the %s animation in the live row', (state) => {
    const html = renderToStaticMarkup(<ReplyStatus streaming status="Working" elapsed={334} tps={0} out={3300} last={null} iconState={state} />);
    expect(html).toContain(`data-reply-icon="${state}"`);
    expect(html).toContain(state === 'thinking' ? 'reply-thought-bubble' : 'reply-terminal-lines');
    expect(html).not.toContain('pixel-head');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('334s');
  });

  it('defaults to the working Nekko', () => {
    const html = renderToStaticMarkup(<ReplyStatus streaming status="Working" elapsed={1} tps={0} out={0} last={null} />);
    expect(html).toContain('pixel-working');
    expect(html).not.toContain('data-reply-icon');
  });

  it('stills the icons under reduced motion', () => {
    const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.reply-activity-icon, .reply-activity-icon * { animation: none !important; }');
  });
});

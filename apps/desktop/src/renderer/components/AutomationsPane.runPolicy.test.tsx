import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationTask } from '@nekko-agent/shared';

vi.mock('../store.js', () => {
  const state = { settings: {} };
  const useStore = (sel: (s: typeof state) => unknown) => sel(state);
  useStore.getState = () => state;
  return { useStore };
});

const { AutomationsPane, AutomationsPausedLine } = await import('./AutomationsPane.js');

const NOW = 1_800_000_000_000;
const task = (over: Partial<AutomationTask>): AutomationTask => ({
  id: 't', title: 'Nightly', kind: 'recurring', prompt: 'p', intervalMs: 3_600_000, status: 'active', createdAt: 1, runCount: 0, ...over,
});

describe('automations pane and the run policy', () => {
  it('shows the CI entry point even with no scheduled automations', () => {
    const html = renderToStaticMarkup(<AutomationsPane tasks={[]} running={new Set()} now={NOW} onOpen={() => {}} />);
    expect(html).toContain('data-ci-runners');
    expect(html).toContain('View CI runners');
    expect(html).toContain('Loading CI runners');
    expect(html).toContain('Nothing scheduled');
  });

  it('says a due task is waiting for you to be away, not "due now"', () => {
    const html = renderToStaticMarkup(
      <AutomationsPane tasks={[task({ nextRunAt: NOW - 600_000, waitingSince: NOW - 600_000 })]} running={new Set()} now={NOW} onOpen={() => {}} />,
    );
    expect(html).toContain('waiting for you to be away');
    expect(html).not.toContain('due now');
    expect(html).toContain('Due 10 mins ago.');
  });

  it('says how the last run started', () => {
    const html = renderToStaticMarkup(
      <AutomationsPane
        tasks={[task({ runCount: 3, lastRunAt: NOW - 60_000, nextRunAt: NOW + 3_540_000, lastRunLowPriority: true, lastRunWaitedMs: 7_200_000 })]}
        running={new Set()}
        now={NOW}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('3 runs · last 1 min ago · low priority · waited 2 hr');
  });

  it('says nothing scheduled in one line, without the illustrated card or a strip chip', () => {
    const html = renderToStaticMarkup(<AutomationsPane tasks={[]} running={new Set()} now={NOW} onOpen={() => {}} />);
    expect(html).toContain('data-automations-empty');
    expect(html).not.toContain('<svg viewBox="0 0 160 96"');
    expect(html).not.toContain('border-dashed');
    expect(html).not.toContain('class="chip');
  });

  it('draws task rows as quiet rows: no card list, no kind emoji tile', () => {
    const html = renderToStaticMarkup(<AutomationsPane tasks={[task({ nextRunAt: NOW + 3_600_000 })]} running={new Set()} now={NOW} onOpen={() => {}} />);
    expect(html).toContain('quiet-row');
    expect(html).not.toContain('divide-y');
    expect(html).not.toContain('🔁');
  });

  it('says paused in one line with Resume, the detail in its tooltip', () => {
    const html = renderToStaticMarkup(<AutomationsPausedLine onResume={() => {}} />);
    expect(html).toContain('All automations are paused');
    expect(html).toContain('Resume');
    expect(html).toContain('title="Schedules, events and polls start nothing until you resume. Run now still works."');
    expect(html).not.toContain('border');
  });
});

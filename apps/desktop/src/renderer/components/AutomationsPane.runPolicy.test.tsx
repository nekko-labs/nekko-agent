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

const { AutomationsPane } = await import('./AutomationsPane.js');

const NOW = 1_800_000_000_000;
const task = (over: Partial<AutomationTask>): AutomationTask => ({
  id: 't', title: 'Nightly', kind: 'recurring', prompt: 'p', intervalMs: 3_600_000, status: 'active', createdAt: 1, runCount: 0, ...over,
});

describe('automations pane and the run policy', () => {
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
});

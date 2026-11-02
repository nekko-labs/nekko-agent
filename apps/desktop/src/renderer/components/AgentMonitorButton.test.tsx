import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({ running: new Set<string>() }));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRunsVersion: () => 0, getLiveRun: (id: string) => (live.running.has(id) ? {} : undefined) }));
vi.mock('../simpleMode.js', async (original) => {
  const { simpleShown } = await import('@nekko-agent/shared');
  return { ...(await original<object>()), useShown: (id: string, context?: object) => simpleShown(id, false, {}, context) };
});
import { AgentMonitorButton } from './PlanRail.js';

const steps = { done: 0, total: 0 };
const render = (backgroundTasks: number, ...subAgents: string[]) =>
  renderToStaticMarkup(<AgentMonitorButton sessionId="s" subAgents={subAgents.map((id) => ({ id }))} backgroundTasks={backgroundTasks} planSteps={steps} />);

describe('the Agent Monitor button in Simple', () => {
  it('stays away while nothing runs in the background', () => {
    live.running.clear();
    expect(render(0)).toBe('');
    expect(render(0, 'finished-child')).toBe('');
  });

  it('shows while a sub-agent runs', () => {
    live.running = new Set(['child']);
    expect(render(0, 'child')).toContain('data-plan-toggle');
  });

  it('shows while Claude Code has background tasks', () => {
    live.running.clear();
    expect(render(2)).toContain('data-plan-toggle');
  });
});

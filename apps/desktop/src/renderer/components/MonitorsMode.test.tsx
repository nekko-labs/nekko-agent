import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE, MONITORS, sanitizeMonitorsDock, type CommandWallState, type MonitorKey } from '../commandWall.js';

/*
 * Simple and Detailed only show or hide the Monitors panel: the checked
 * monitors in Configure are the one source of truth for which monitors show,
 * in both modes. useShown and the local-model probe stay real here, so a
 * per-mode filter on the monitors would fail these tests.
 */
const mode = vi.hoisted(() => ({ expert: false }));
vi.mock('../simpleMode.js', async (original) => ({ ...(await original<object>()), useExpertMode: () => [mode.expert, vi.fn()] }));
vi.mock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }));
vi.mock('../useLimits.js', () => ({ useProviderLimitsPortfolio: () => ({ byToken: {}, answered: new Set(), nextRefreshAt: null }) }));
vi.mock('../accountEmails.js', async (orig) => ({ ...(await orig<typeof import('../accountEmails.js')>()), useAccountEmails: () => ({}) }));
vi.mock('./InsightsBox.js', () => ({ InsightsBox: () => null }));
vi.mock('./AutomationsPane.js', () => ({ AutomationsPane: () => null }));
vi.mock('./ResourceMonitor.js', () => ({ MonitorComputerSwitch: () => null, useMonitors: () => ({ cpu: true, memory: true, gpu: true, vram: true }), useResourceSample: () => ({ system: { cpuPct: 18, memUsedMB: 2048, memTotalMB: 8192 }, gpu: null }) }));
import { MonitorsDock } from './MonitorsDock.js';

const vitals = { working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] };
const ALL = MONITORS.map((p) => p.key);

function render(dock: Partial<CommandWallState['dock']>, setState = vi.fn()) {
  const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, ...dock } };
  const html = renderToStaticMarkup(<MonitorsDock state={state} setState={setState} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={null} vitals={vitals} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
  return { html, state, setState };
}
const shown = (html: string) => [...html.matchAll(/data-monitor="([a-zA-Z]+)"/g)].map((m) => m[1]);
const checked = (keys: MonitorKey[]) => Object.fromEntries(ALL.map((k) => [k, keys.includes(k)])) as Record<MonitorKey, boolean>;

describe('Monitors in Simple and Detailed', () => {
  const picks: MonitorKey[][] = [ALL, ['hardware', 'budget'], ['utilization', 'localModels', 'insights'], ['automations']];
  for (const expert of [false, true]) {
    it.each(picks)(`shows exactly the checked monitors in ${expert ? 'Detailed' : 'Simple'} (%s ...)`, (...keys) => {
      mode.expert = expert;
      const { html } = render({ show: true, simpleShow: true, monitors: checked(keys) });
      expect(shown(html).sort()).toEqual([...keys].sort());
      expect(html).toContain(`${keys.length} of ${MONITORS.length}`);
    });
  }

  it('keeps the Configure checkboxes and the shown monitors the same set when the mode changes', () => {
    const monitors = checked(['hardware', 'localModels', 'budget', 'utilization']);
    mode.expert = false;
    const simple = shown(render({ show: true, simpleShow: true, monitors }).html);
    mode.expert = true;
    const detailed = shown(render({ show: true, simpleShow: true, monitors }).html);
    expect(simple).toEqual(detailed);
  });

  it('starts closed in Simple and open in Detailed, each remembering its own toggle', () => {
    const dock = sanitizeMonitorsDock(undefined);
    expect(dock.show).toBe(true);
    expect(dock.simpleShow).toBe(false);
    mode.expert = false;
    expect(render(dock).html).toMatch(/^<div class="monitors-dock-collapsed"/);
    mode.expert = true;
    expect(render(dock).html).toContain('aria-label="Monitors"');
    expect(sanitizeMonitorsDock({ ...dock, simpleShow: true }).simpleShow).toBe(true);
  });

  it('writes the panel toggle to the current mode only, never the checked monitors', () => {
    for (const expert of [false, true]) {
      mode.expert = expert;
      const setState = vi.fn();
      const { state } = render({ show: true, simpleShow: true }, setState);
      findToggle(state, setState)();
      const next = setState.mock.calls[0][0](state) as CommandWallState;
      expect(next.dock.monitors).toEqual(state.dock.monitors);
      expect(next.dock.show).toBe(expert ? false : true);
      expect(next.dock.simpleShow).toBe(expert ? true : false);
    }
  });
});

/** The hide button's handler, found by walking the rendered element tree. */
function findToggle(state: CommandWallState, setState: ReturnType<typeof vi.fn>): () => void {
  let found: (() => void) | null = null;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const el = node as React.ReactElement<Record<string, unknown>>;
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'MonitorsToggle' && el.props.show === true) { found = el.props.onToggle as () => void; return; }
    visit(el.props?.children);
  };
  // Render the dock component as a plain function to read its element tree.
  // Hooks need a dispatcher, so do it inside a throwaway static render.
  function Probe() { visit((MonitorsDock as (p: unknown) => React.ReactNode)({ state, setState, tasks: [], running: new Set(), now: 0, sessions: [], providers: [], usage: null, vitals, onOpenChat: vi.fn(), onOpenModels: vi.fn() })); return null; }
  renderToStaticMarkup(<Probe />);
  if (!found) throw new Error('no hide button');
  return found;
}

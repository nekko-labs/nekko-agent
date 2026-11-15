import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootedSimulator, SimulatorsState } from '@nekko-agent/shared';

vi.mock('../store.js', () => ({
  useStore: Object.assign((pick: (s: unknown) => unknown) => pick({ openChatPane: () => {}, settings: {} }), {
    getState: () => ({ pushToast: () => {}, setPlanRail: () => {} }),
  }),
}));

import { SimulatorRows, SimulatorChipSegment, SimulatorSection, SimulatorStatus, autoOpenKey, openSimulatorAndChat, openTitle, simulatorRowDetail } from './Simulators.js';
import { resetSimulatorsForTest, simulatorsSnapshot, subscribeSimulators, onSimulatorUsed } from '../simulators.js';

const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
const MIN = 60_000;

function device(over: Partial<BootedSimulator> = {}): BootedSimulator {
  return { id: 'A205885C', kind: 'ios', name: 'Nekko-1314-iPad', cpuPct: 95.1, upSecs: 10 * 3600, processes: 274, canOpen: true, ...over };
}

const STATE: SimulatorsState = {
  sampledAt: NOW,
  devices: [
    device({ lastUse: { sessionId: 'chat-a', at: NOW - 2 * MIN, title: 'iPad PanesTests' } }),
    device({ id: '937C0078', name: 'Nekko-1882-phone-setup-owned', cpuPct: 0.6, upSecs: 9 * 86_400 }),
    device({ id: 'agent2649_api36', kind: 'android', name: 'agent2649 api36', cpuPct: 6.2, upSecs: 3600, canOpen: false }),
  ],
};

afterEach(() => { resetSimulatorsForTest(); vi.unstubAllGlobals(); });

describe('Simulators group in the Hardware monitor', () => {
  it('is absent while no simulator is booted', () => {
    expect(renderToStaticMarkup(<SimulatorRows state={{ devices: [], sampledAt: NOW }} />)).toBe('');
    expect(renderToStaticMarkup(<SimulatorRows state={null} />)).toBe('');
  });

  it('lists each device with its CPU, the chat that used it, idle time and actions', () => {
    const html = renderToStaticMarkup(<SimulatorRows state={STATE} />);
    expect(html).toContain('3 running · 102% CPU');
    expect(html).toContain('Nekko-1314-iPad');
    expect(html).toContain('95% CPU');
    expect(html).toContain('95% CPU · used by iPad PanesTests, 2 min ago · up 10 h');
    expect(html).toContain('&lt;1% CPU · idle 9 days · up 9 days');
    // Open only where Simulator.app can show it; Shut down on every row.
    expect(html.match(/>Open</g)?.length).toBe(2);
    expect(html.match(/>Shut down</g)?.length).toBe(3);
  });

  it('folds to its header, which keeps the count and CPU', () => {
    const open = renderToStaticMarkup(<SimulatorRows state={STATE} />);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('data-simulator-auto-shutdown');
    const folded = renderToStaticMarkup(<SimulatorRows state={STATE} collapsed />);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain('3 running · 102% CPU');
    expect(folded).not.toContain('Nekko-1314-iPad');
    expect(folded).not.toContain('data-simulator-auto-shutdown');
  });

  it('offers auto shutdown after 5 and 15 minutes as well', () => {
    const html = renderToStaticMarkup(<SimulatorRows state={STATE} />);
    for (const label of ['Never', 'After 5 min', 'After 15 min', 'After 30 min', 'After 1 hour', 'After 4 hours']) expect(html).toContain(`>${label}<`);
  });

  it('Open opens the chat that used the device and the device’s window', () => {
    const simulatorsOpen = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { nekko: { simulatorsOpen } });
    const opened: string[] = [];
    const used = STATE.devices[0];
    openSimulatorAndChat(used, (id) => opened.push(id));
    expect(opened).toEqual(['chat-a']);
    expect(simulatorsOpen).toHaveBeenCalledWith('A205885C');
    expect(openTitle(used)).toBe('Open the chat using Nekko-1314-iPad and Nekko-1314-iPad’s window'.replace('’', "'"));
    // Nobody's: the window only. A headless emulator an agent used: the chat only.
    openSimulatorAndChat(STATE.devices[1], (id) => opened.push(id));
    expect(opened).toEqual(['chat-a']);
    expect(simulatorsOpen).toHaveBeenCalledTimes(2);
    openSimulatorAndChat({ ...STATE.devices[2], lastUse: { sessionId: 'chat-b', at: NOW } }, (id) => opened.push(id));
    expect(opened).toEqual(['chat-a', 'chat-b']);
    expect(simulatorsOpen).toHaveBeenCalledTimes(2);
  });

  it('says how long a device has been up beside its use', () => {
    expect(simulatorRowDetail(device({ lastUse: undefined, model: 'iPad Pro', os: 'iOS 26.5' }), NOW)).toBe('95% CPU · iPad Pro · iOS 26.5 · up 10 h');
  });
});

describe('the chat’s simulator', () => {
  it('shows the Simulator panel only in the chat that used a device', () => {
    expect(renderToStaticMarkup(<SimulatorSection sessionId="chat-b" state={STATE} />)).toBe('');
    const html = renderToStaticMarkup(<SimulatorSection sessionId="chat-a" state={STATE} />);
    expect(html).toContain('data-simulator-section');
    expect(html).toContain('data-simulator-screen');
    expect(html).toContain('Open window');
  });

  it('says above the composer that the chat’s simulator is running', () => {
    expect(renderToStaticMarkup(<SimulatorStatus sessionId="chat-b" state={STATE} onOpen={() => {}} />)).toBe('');
    const html = renderToStaticMarkup(<SimulatorStatus sessionId="chat-a" state={STATE} onOpen={() => {}} />);
    expect(html).toContain('Nekko-1314-iPad is running');
    expect(html).toContain('95% CPU');
  });

  it('opens the panel once per chat and device', () => {
    const used = { sessionId: 'chat-a', deviceId: 'A205885C' };
    expect(autoOpenKey('chat-a', used, new Set())).toBe('chat-a:A205885C');
    expect(autoOpenKey('chat-a', used, new Set(['chat-a:A205885C']))).toBeNull();
    expect(autoOpenKey('chat-b', used, new Set())).toBeNull();
  });
});

describe('the shared sampler', () => {
  it('reads once on the first subscriber, again on simulators:updated, and passes on a chat that started', async () => {
    let fire: (e: { used?: { deviceId: string; sessionId: string; at: number } }) => void = () => {};
    const simulatorsState = vi.fn().mockResolvedValue(STATE);
    vi.stubGlobal('window', { nekko: { simulatorsState, onSimulatorsUpdated: (cb: typeof fire) => { fire = cb; return () => {}; } } });
    const heard: string[] = [];
    onSimulatorUsed((u) => heard.push(u.sessionId));
    const stop = subscribeSimulators(() => {});
    await vi.waitFor(() => expect(simulatorsSnapshot()).toEqual(STATE));
    expect(simulatorsState).toHaveBeenCalledTimes(1);
    fire({ used: { deviceId: 'A205885C', sessionId: 'chat-a', at: NOW } });
    expect(heard).toEqual(['chat-a']);
    await vi.waitFor(() => expect(simulatorsState).toHaveBeenCalledTimes(2));
    stop();
  });

  it('is absent from the chip while nothing is booted', () => {
    expect(renderToStaticMarkup(<SimulatorChipSegment />)).toBe('');
  });
});

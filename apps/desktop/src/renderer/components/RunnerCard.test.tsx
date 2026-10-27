import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_RUNNER_SETTINGS, type RunnerView } from '@nekko-agent/shared';

vi.mock('./primitives/index.js', async (original) => ({
  ...await original<typeof import('./primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

import { RunnerCard } from './RunnerCard.js';

(globalThis as unknown as { window: unknown }).window = { nekko: { setRunnerEnabled: () => Promise.reject(new Error('unused')) } };

const now = 1_800_000_000;
const view = (over: Partial<RunnerView> = {}): RunnerView => ({
  config: {
    id: 'r1',
    scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' },
    label: 'nekko-mac',
    settings: { ...DEFAULT_RUNNER_SETTINGS, enabled: true, macosSlots: 2 },
  },
  state: 'running',
  slots: [{ state: 'running', job: { repo: 'nekko-labs/nekko-agent', runId: 1, jobId: 2, workflow: 'ios-native', job: 'PR #904' }, since: now - 360, drainEndsAt: null }],
  reasons: ['userActive'],
  available: 2,
  limit: null,
  awake: true,
  error: null,
  today: { jobs: 14, seconds: 7800 },
  host: { ramMb: 32768, cores: 10, recommendedMemoryMb: 16384, runnerMemoryMb: 16384, cpusPerVm: 4, onBattery: false, batteryPct: 100, networkId: 'home', networkTrusted: true },
  recent: [
    { ts: now - 600, runnerId: 'r1', repo: 'nekko-labs/nekko-agent', workflow: 'mobile', job: 'iOS build', result: 'finished', seconds: 660, reason: [] },
    { ts: now - 1800, runnerId: 'r1', repo: 'nekko-labs/nekko-agent', workflow: 'ci', job: 'darwin daemon', result: 'stopped', seconds: 120, reason: ['userBusy'] },
  ],
  ...over,
});
const render = (v: RunnerView) => renderToStaticMarkup(<RunnerCard view={v} now={now} onSettings={() => {}} beginReply={() => () => {}} />);

describe('RunnerCard', () => {
  it('running_card_matches_mockup_3', () => {
    const html = render(view());
    for (const s of [
      'This Mac · GitHub · nekko-labs/nekko-agent', 'Slot 1 · macOS', 'ios-native · PR #904 · 6 min', 'Waiting: you&#x27;re using the Mac',
      '8 GB · 4 cores', 'On AC', 'Trusted · home', '14 jobs · 2 h 10 min', 'role="switch" aria-checked="true" aria-label="Runner on for nekko-labs/nekko-agent"',
      'data-runner-card="r1"', 'aria-label="Runner settings for nekko-labs/nekko-agent"', 'ci · darwin daemon · stopped after 2 min',
    ]) expect(html).toContain(s);
  });

  it('error_card_shows_the_daemons_sentence', () => {
    expect(render(view({ state: 'error', error: 'No VM image yet.', slots: [] }))).toMatch(/role="alert"[^>]*>[^<]*No VM image yet\./);
  });

  it('an off runner still shows the daemon error', () => {
    const html = render(view({ state: 'off', error: 'VM support unavailable: the nekko-vm helper is not installed.', slots: [] }));
    expect(html).toMatch(/role="alert"[^>]*>[^<]*VM support unavailable: the nekko-vm helper is not installed\./);
  });

  it('an unsampled host with an error reads Unavailable', () => {
    const zero = { ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0, onBattery: null, batteryPct: null, networkId: null, networkTrusted: false };
    const html = render(view({ state: 'off', host: zero, error: 'VM support unavailable: the nekko-vm helper is not installed.' }));
    expect(html).toContain('>Unavailable<');
    expect(html).not.toContain('Not known yet');
  });

  it('rounds the battery percent', () => {
    expect(render(view({ host: { ...view().host, onBattery: true, batteryPct: 61.6 } }))).toContain('On battery, 62%');
  });

  it('waiting_card_lists_every_reason', () => {
    const html = render(view({ state: 'waiting', slots: [], reasons: ['onBattery', 'network'] }));
    expect(html).toContain('This Mac is on battery, below what this mode allows.');
    expect(html).toContain('This network is not one you trust. Add it in runner settings.');
  });

  // Zeros mean "not sampled" or "no VM support"; the latter already shows the error banner.
  it('says the VM size is not known before the first sample', () => {
    const html = render(view({ host: { ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0, onBattery: null, batteryPct: null, networkId: null, networkTrusted: false } }));
    expect(html).not.toContain('0 cores');
    expect(html).toContain('Not known yet');
    expect(html).not.toContain('VM support unavailable');
  });

  it('no_em_dash_in_markup', () => {
    expect(render(view())).not.toContain('\u2014');
  });
});

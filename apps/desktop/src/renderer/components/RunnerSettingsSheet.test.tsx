import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_RUNNER_SETTINGS, KEEP_AWAKE_LABELS, PRIORITY_LABELS, type HostView, type RunnerSettings, type RunnerView } from '@nekko-agent/shared';

vi.mock('./primitives/index.js', async (original) => ({
  ...await original<typeof import('./primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

import { SettingsBody, saveSettings, trustNetwork } from './RunnerSettingsSheet.js';

const host: HostView = {
  ramMb: 36864, cores: 12, recommendedMemoryMb: 24576, runnerMemoryMb: 18432, cpusPerVm: 4,
  onBattery: false, batteryPct: 100, networkId: 'gw:aa:bb:cc:dd:ee:ff', networkTrusted: true,
};
const view = (over: Partial<RunnerView> = {}, settings: Partial<RunnerSettings> = {}): RunnerView => ({
  config: { id: 'r1', scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' }, label: 'nekko-mac', settings: { ...DEFAULT_RUNNER_SETTINGS, enabled: true, ...settings } },
  state: 'ready', slots: [], reasons: [], available: 2, limit: null, awake: false, error: null, today: { jobs: 0, seconds: 0 }, host, recent: [], ...over,
});
const render = (v: RunnerView, draft = v.config.settings) =>
  renderToStaticMarkup(<SettingsBody view={v} draft={draft} onDraft={() => {}} onEnabled={() => {}} onSave={() => {}} onRemove={() => {}} saving={false} />);
const esc = (s: string) => renderToStaticMarkup(<>{s}</>);

describe('RunnerSettingsSheet', () => {
  it('settings_match_mockup_4', () => {
    const html = render(view({}, { trustedNetworks: ['gw:aa:bb:cc:dd:ee:ff', 'gw:11:22:33:44:55:66'] }));
    for (const s of [
      'Runner', 'On. Turning off stops and deletes any running VM.', 'Priority', 'Keep awake', 'sleep normally, or stay up for jobs',
      'macOS slots', 'Apple allows 2 per Mac', 'Memory per VM', '36 GB Mac, runner cap 18 GB', '8 GB', 'Total runner memory', 'Use the recommendation',
      'CPU per VM', 'Mode default', 'Disk', 'images and clones', 'Only when', 'On power', 'Trusted networks', 'Never on hotspots',
      'recognised by the router&#x27;s hardware address', 'This network', 'Remove', 'Safety', 'Re-run jobs lost to sleep', 'Max job time',
      '30 min', '1 h', '2 h', '6 h', 'Remove runner', 'Cancel', 'Save',
      'Let jobs use the internet directly while a VPN is on', 'Recommended: 24 GB for this Mac', '4 of 12', '150 GB, keep 25 GB free',
    ]) expect(html).toContain(s);
    for (const l of [...Object.values(PRIORITY_LABELS), ...Object.values(KEEP_AWAKE_LABELS)]) expect(html).toContain(esc(l));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>3 not allowed<\/button>/);
    for (const s of ['Linux slots', 'Run fork pull requests', 'Build cache', 'Outside 9:00', '\u2014']) expect(html).not.toContain(s);
    expect(html).not.toContain('Trust this network');
  });

  it('hides_the_recommendation_before_the_first_sample', () => {
    const zero: HostView = { ...host, ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0, networkId: null };
    expect(render(view({ host: zero }))).not.toContain('Recommended: 0');
  });

  it('offers_to_trust_the_current_network', () => {
    expect(render(view())).toContain('Trust this network');
  });

  it('slot_limit_is_explained', () => {
    expect(render(view({ limit: 'memory' }))).toContain('Not enough runner memory for another VM.');
  });

  it('trust_this_network_adds_the_current_id', () => {
    const d = DEFAULT_RUNNER_SETTINGS;
    expect(trustNetwork(d, host).trustedNetworks).toEqual(['gw:aa:bb:cc:dd:ee:ff']);
    const listed = { ...d, trustedNetworks: ['gw:aa:bb:cc:dd:ee:ff'] };
    expect(trustNetwork(listed, host)).toBe(listed);
    expect(trustNetwork(d, { ...host, networkId: null })).toBe(d);
    const full = { ...d, trustedNetworks: Array.from({ length: 32 }, (_, i) => `gw:${i}`) };
    expect(trustNetwork(full, host)).toBe(full);
  });

  it('save_shows_what_the_daemon_kept', async () => {
    const v = view({}, { enabled: true });
    const draft = { ...v.config.settings, maxJobMinutes: 5, enabled: false };
    const kept = view({}, { maxJobMinutes: 10 });
    const updateRunner = vi.fn(async () => kept);
    const res = await saveSettings(v, draft, { updateRunner, pushToast: vi.fn() });
    expect(updateRunner).toHaveBeenCalledWith('r1', { ...draft, enabled: true });
    expect(res?.draft.maxJobMinutes).toBe(10);
    expect(res?.view).toBe(kept);
  });

  it('save_failure_is_a_toast', async () => {
    const pushToast = vi.fn();
    const res = await saveSettings(view(), view().config.settings, { updateRunner: () => Promise.reject(new Error('The daemon said no.')), pushToast });
    expect(res).toBeNull();
    expect(pushToast).toHaveBeenCalledWith('error', 'Could not save runner settings: The daemon said no.');
  });

  it('max_job_time_shows_an_odd_value', () => {
    expect(render(view({}, { maxJobMinutes: 45 }))).toMatch(/aria-pressed="true"[^>]*>45 min</);
  });
});

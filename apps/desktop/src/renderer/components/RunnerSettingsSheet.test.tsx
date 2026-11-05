import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_RUNNER_SETTINGS, KEEP_AWAKE_LABELS, PRIORITY_LABELS, type HostView, type ImageView, type LinuxImageView, type RunnerSettings, type RunnerView } from '@nekko-agent/shared';

vi.mock('./primitives/index.js', async (original) => ({
  ...await original<typeof import('./primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

import { LinuxImageRow, SettingsBody, editDraft, saveSettings, shownSettings, trustNetwork } from './RunnerSettingsSheet.js';

const host: HostView = {
  ramMb: 36864, cores: 12, recommendedMemoryMb: 24576, runnerMemoryMb: 18432, cpusPerVm: 4,
  onBattery: false, batteryPct: 100, networkId: 'gw:aa:bb:cc:dd:ee:ff', networkTrusted: true,
};
const view = (over: Partial<RunnerView> = {}, settings: Partial<RunnerSettings> = {}): RunnerView => ({
  config: { id: 'r1', scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' }, label: 'nekko-cloud-mac', settings: { ...DEFAULT_RUNNER_SETTINGS, enabled: true, ...settings } },
  state: 'ready', slots: [], reasons: [], available: 2, limit: null, awake: false, error: null, today: { jobs: 0, seconds: 0 }, host, repos: [], forkApprovalOpen: false, recent: [], ...over,
});
const render = (v: RunnerView, draft = v.config.settings, image: ImageView | null = null) =>
  renderToStaticMarkup(<SettingsBody view={v} image={image} draft={draft} onDraft={() => {}} onEnabled={() => {}} onSave={() => {}} onRemove={() => {}} saving={false} />);
const esc = (s: string) => renderToStaticMarkup(<>{s}</>);

describe('RunnerSettingsSheet', () => {
  it('rebuild_image_shows_only_with_an_image_at_rest', () => {
    const image: ImageView = { state: 'ready', kind: null, stage: null, doneStages: [], detail: '', bytes: null, fraction: null, error: null, log: null, info: { macos: '27.2', xcode: '27.2', actionsRunner: '2.330.0', built: '2026-11-01' }, canResume: false };
    const html = render(view(), undefined, image);
    expect(html).toContain('Rebuild image');
    expect(html).toContain('macOS 27.2 · Xcode 27.2');
    expect(render(view(), undefined, { ...image, state: 'building' })).not.toContain('Rebuild image');
    expect(render(view())).not.toContain('Rebuild image');
    // Update scripts sits beside it when the sheet can start one.
    expect(html).not.toContain('Update scripts');
    const withRefresh = renderToStaticMarkup(<SettingsBody view={view()} image={image} draft={view().config.settings} onDraft={() => {}} onEnabled={() => {}} onSave={() => {}} onRemove={() => {}} onRefresh={() => {}} saving={false} />);
    expect(withRefresh).toContain('>Update scripts<');
    expect(withRefresh).toContain(esc("Update scripts puts this version of Nekko's scripts into the image in a few minutes. A new macOS or Xcode needs Rebuild image."));
  });

  it('settings_match_mockup_4', () => {
    const html = render(view({}, { trustedNetworks: ['gw:aa:bb:cc:dd:ee:ff', 'gw:11:22:33:44:55:66'] }));
    for (const s of [
      'Runner', 'On. Turning off stops and deletes any running VM.', 'Priority', 'Keep awake', 'sleep normally, or stay up for jobs',
      'macOS slots', 'Apple allows 2 per Mac', 'Memory per VM', '36 GB Mac, runner cap 18 GB', '8 GB', 'Total runner memory', 'Use the recommendation',
      'CPU per VM', 'Mode default', 'Disk', 'images and clones', 'Only when', 'On power', 'Trusted networks', 'Never on hotspots',
      'recognised by the router&#x27;s hardware address', 'This network', 'Remove', 'Safety', 'Re-run jobs lost to sleep', 'Max job time',
      '30 min', '1 h', '2 h', '6 h', 'Remove runner', 'Cancel', 'Save',
      'Let jobs use the internet directly while a VPN is on', 'Recommended: 24 GB for this Mac', '4 of 12',
    ]) expect(html).toContain(s);
    for (const l of [...Object.values(PRIORITY_LABELS), ...Object.values(KEEP_AWAKE_LABELS)]) expect(html).toContain(esc(l));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>3 not allowed<\/button>/);
    for (const s of ['Run fork pull requests', 'Build cache', 'Outside 9:00', '\u2014', 'keep 25 GB free']) expect(html).not.toContain(s);
    expect(html).not.toContain('Trust this network');
  });

  it('hides_the_recommendation_before_the_first_sample', () => {
    const zero: HostView = { ...host, ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0, networkId: null };
    expect(render(view({ host: zero }))).not.toContain('Recommended: 0');
  });

  it('before_the_first_sample_nothing_is_bounded_by_a_zero_host', async () => {
    const zero: HostView = { ...host, ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0, networkId: null };
    const v = view({ host: zero }, { cpusPerVm: 6, runnerMemoryMb: 20480 });
    const html = render(v);
    expect(html).toContain('Waiting for this Mac&#x27;s first reading.');
    expect(html).toMatch(/<input type="checkbox" disabled=""[^>]*\/>Mode default/);
    expect(html.match(/<input type="radio"[^>]*name="runner-memory"[^>]*>/g)?.map((r) => r.includes('disabled=""'))).toEqual([true, true]);
    expect(html).not.toContain('aria-label="CPU per VM"');
    expect(html).not.toContain('aria-label="Total runner memory in GB"');
    for (const s of ['0 GB Mac', 'of 0', ' 0 GB']) expect(html).not.toContain(s);
    const updateRunner = vi.fn(async () => v);
    await saveSettings(v, v.config.settings, shownSettings(v, null), { updateRunner, pushToast: vi.fn() });
    expect(updateRunner).toHaveBeenCalledWith('r1', {}); // nothing changed, so nothing is overwritten
  });

  it('a_push_while_unedited_replaces_the_form', () => {
    const before = view();
    const pushed = view({}, { maxJobMinutes: 360 });
    expect(shownSettings(pushed, null).maxJobMinutes).toBe(360);
    const edits = { ...before.config.settings, maxJobMinutes: 30 };
    expect(shownSettings(pushed, edits)).toBe(edits);
  });

  it('a push during an edit is not reverted by Save', async () => {
    // Open with A, edit max job time (the draft and its base are A then), a push adds network B, Save.
    const opened = view({}, { trustedNetworks: [] });
    let edits = editDraft(null, opened, { ...opened.config.settings, maxJobMinutes: 360 });
    const pushed = view({}, { trustedNetworks: ['gw:b'] });
    edits = editDraft(edits, pushed, { ...edits.draft, rerunLostJobs: false }); // a later edit keeps the first base
    expect(edits.base).toBe(opened.config.settings);
    const updateRunner = vi.fn(async (_id: string, _patch: object) => pushed);
    await saveSettings(pushed, edits.base, edits.draft, { updateRunner, pushToast: vi.fn() });
    expect(updateRunner).toHaveBeenCalledWith('r1', { maxJobMinutes: 360, rerunLostJobs: false });
  });

  it('before the first sample memory per VM is shown, not offered', () => {
    const zero: HostView = { ...host, ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0, networkId: null };
    const html = render(view({ host: zero }));
    expect(html).not.toContain('aria-label="Memory per VM in GB"');
    expect(html).toContain('8 GB per VM');
  });

  it('without VM support the sheet says why instead of waiting', () => {
    const zero: HostView = { ...host, ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0, networkId: null };
    const html = render(view({ host: zero, error: 'VM support unavailable: the nekko-vm helper is not installed.' }));
    expect(html).toContain('VM support unavailable: the nekko-vm helper is not installed.');
    expect(html).not.toContain('first reading');
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
    const res = await saveSettings(v, v.config.settings, draft, { updateRunner, pushToast: vi.fn() });
    expect(updateRunner).toHaveBeenCalledWith('r1', { maxJobMinutes: 5 }); // never `enabled`: that is the switch's
    expect(res?.draft.maxJobMinutes).toBe(10);
    expect(res?.view).toBe(kept);
  });

  it('save_failure_is_a_toast', async () => {
    const pushToast = vi.fn();
    const res = await saveSettings(view(), view().config.settings, view().config.settings, { updateRunner: () => Promise.reject(new Error('The daemon said no.')), pushToast });
    expect(res).toBeNull();
    expect(pushToast).toHaveBeenCalledWith('error', 'Could not save runner settings: The daemon said no.');
  });

  it('max_job_time_shows_an_odd_value', () => {
    expect(render(view({}, { maxJobMinutes: 45 }))).toMatch(/aria-pressed="true"[^>]*>45 min</);
  });

  it('linux_slots_and_their_image_row', () => {
    const html = render(view({}, { linuxSlots: 2 }));
    expect(html).toContain('aria-label="Linux slots"');
    expect(html).toContain('nekko-cloud-mac-linux');
    const img = (over: Partial<LinuxImageView>): LinuxImageView => ({ state: 'none', stage: null, progress: null, message: null, proof: null, ...over });
    const row = (i: LinuxImageView) => renderToStaticMarkup(<LinuxImageRow image={i} onAction={() => {}} />);
    expect(row(img({}))).toContain('Set up Linux image');
    expect(row(img({ state: 'building', stage: 'download', message: 'Downloading Ubuntu 24.04 (1 of 3)', progress: 0.42 }))).toContain('Downloading: Downloading Ubuntu 24.04 (1 of 3) 42%');
    expect(row(img({ state: 'building', stage: 'provision' }))).toContain('Cancel');
    const ready = row(img({ state: 'ready', proof: { distro: 'ubuntu-24.04', runner: '2.338.1', docker: '29.1.3' } }));
    expect(ready).toContain('Rebuild Linux image');
    expect(ready).toContain('ubuntu-24.04 · runner 2.338.1 · Docker 29.1.3');
    expect(row(img({ state: 'failed', message: 'The download stalled. Try again.' }))).toContain('The download stalled. Try again.');
    // Without a Linux image view (an older daemon), the sheet shows no image row.
    expect(html).not.toContain('Linux image');
  });
});

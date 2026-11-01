import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNNER_SETTINGS,
  KEEP_AWAKE_LABELS,
  PRIORITY_DESCRIPTIONS,
  PRIORITY_LABELS,
  REASONS,
  SLOT_LIMITS,
  STATE_LABELS,
  VPN_DIRECT_LABEL,
  auditText,
  formatMinutes,
  imageFraction,
  imageLine,
  imageStageRows,
  settingsPatch,
  todayText,
  reasonText,
  networkText,
  recommendationText,
  runnerActivity,
  runnerSubtitle,
  runnerTitle,
  runnerWorkflowPrompt,
  slotLimitText,
  slotLines,
  toConnectRequest,
  type AuditLine,
  type ConnectForm,
  type HostView,
  type ImageView,
  type RunnerView,
  type SlotView,
} from './runners.js';

const now = 1_800_000_000;
const host: HostView = {
  ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0,
  onBattery: null, batteryPct: null, networkId: null, networkTrusted: false,
};
const view = (over: Partial<RunnerView> = {}, settings: Partial<RunnerView['config']['settings']> = {}): RunnerView => ({
  config: {
    id: 'r1',
    scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' },
    label: 'nekko-cloud-mac',
    settings: { ...DEFAULT_RUNNER_SETTINGS, ...settings },
  },
  state: 'waiting', slots: [], reasons: [], available: 1, limit: null, awake: false, error: null,
  today: { jobs: 0, seconds: 0 }, host, repos: [], recent: [],
  ...over,
});
const slot = (state: SlotView['state'], over: Partial<SlotView> = {}): SlotView => ({ state, job: null, since: now, drainEndsAt: null, ...over });

describe('runner copy', () => {
  it('has exact mode and keep-awake labels', () => {
    expect(PRIORITY_LABELS).toEqual({ doNotDisturb: "Do not disturb: Only run when I'm idle", balanced: 'Balanced: in the background', runnerFirst: 'Runner first' });
    expect(KEEP_AWAKE_LABELS).toEqual({ systemDefault: 'System default', whileActive: 'While a runner is active', always: 'Always' });
    expect(VPN_DIRECT_LABEL).toBe('Let jobs use the internet directly while a VPN is on');
  });

  it('has a label for every slot limit', () => {
    expect(Object.keys(SLOT_LIMITS).sort()).toEqual(['appleCap', 'memory', 'otherApps']);
  });

  it('unknown_reason_and_limit_fall_back', () => {
    expect(reasonText('solarFlare')).toEqual({ short: 'a condition is not met', sentence: 'A condition is not met.' });
    expect(reasonText('toString').sentence).toBe('A condition is not met.');
    expect(reasonText('userBusy').short).toBe('your apps are busy');
    expect(slotLimitText('newBound')).toBe('Fewer slots are available right now.');
    expect(slotLimitText('appleCap')).toBe('Apple allows 2 macOS VMs per Mac.');
  });

  it('never uses an em dash in copy', () => {
    const all = JSON.stringify([PRIORITY_LABELS, PRIORITY_DESCRIPTIONS, KEEP_AWAKE_LABELS, REASONS, SLOT_LIMITS, STATE_LABELS, VPN_DIRECT_LABEL]);
    expect(all).not.toContain('\u2014');
  });
});

describe('runner helpers', () => {
  it('formats minutes', () => {
    expect([formatMinutes(20), formatMinutes(360), formatMinutes(7800), formatMinutes(7200)]).toEqual(['under 1 min', '6 min', '2 h 10 min', '2 h']);
  });

  it('titles a runner like the mockup', () => {
    const v = view();
    expect(runnerTitle(v)).toBe('This Mac · GitHub · nekko-labs/nekko-agent');
    expect(runnerSubtitle(v)).toBe("repo scope · label nekko-cloud-mac · Do not disturb: Only run when I'm idle · While a runner is active");
    expect(runnerTitle(view({ config: { ...v.config, scope: { kind: 'org', org: 'acme' } } }))).toBe('This Mac · GitHub · acme');
  });

  it('slot_lines_grey_out_slots_past_available', () => {
    const job = { repo: 'nekko-labs/nekko-agent', runId: 1, jobId: 2, workflow: 'ios-native', job: 'PR #904' };
    const v = view({ available: 1, limit: 'otherApps', state: 'running', slots: [slot('running', { job, since: now - 360 })] }, { macosSlots: 2, maxJobMinutes: 120 });
    expect(slotLines(v, now)).toEqual([
      { title: 'Slot 1 · macOS', text: 'ios-native · PR #904 · 6 min', progress: 0.05, dim: false },
      { title: 'Slot 2 · macOS', text: 'Not available: Another app is running a macOS VM.', progress: 0, dim: true },
    ]);

    const waiting = slotLines(view({ available: 2, reasons: ['userActive'] }, { macosSlots: 2 }), now);
    expect(waiting.map((l) => [l.text, l.dim])).toEqual([["Waiting: you're using the Mac", false], ["Waiting: you're using the Mac", false]]);

    const states = view({ available: 4, slots: [slot('starting'), slot('ready'), slot('draining', { drainEndsAt: now + 90 }), slot('cleaning')] }, { macosSlots: 4 });
    expect(slotLines(states, now).map((l) => l.text)).toEqual(['Starting a VM', 'Ready for a job', 'Finishing, stops in 2 min', 'Deleting the VM']);

    expect(slotLines(view(), now).map((l) => l.text)).toEqual(['Starts a VM when a job is queued']);
    expect(slotLines(view({ state: 'error', error: 'No VM image yet.' }), now).map((l) => l.text)).toEqual(['Stopped until the error above is fixed']);
    // A bound with no name still greys the slot with a sentence.
    expect(slotLines(view({ available: 0 }), now)[0]).toEqual({ title: 'Slot 1 · macOS', text: 'Not available: Fewer slots are available right now.', progress: 0, dim: true });
    // A job past the max time caps at a full bar.
    expect(slotLines(view({ slots: [slot('running', { job, since: now - 99_999 })] }), now)[0].progress).toBe(1);
  });

  it('describes recent jobs', () => {
    const line = (over: Partial<AuditLine>): AuditLine => ({ ts: now, runnerId: 'r', repo: 'o/r', workflow: 'ci', job: 'darwin daemon', result: 'finished', seconds: 120, reason: [], ...over });
    expect(auditText(line({ workflow: 'mobile', job: 'iOS build', seconds: 660 }))).toBe('mobile · iOS build · finished · 11 min · VM deleted');
    expect(auditText(line({ result: 'stopped', reason: ['userBusy'] }))).toBe('ci · darwin daemon · stopped after 2 min (your apps are busy) · VM deleted');
    // AuditLine does not say whether that job was re-run; only the current setting is known.
    expect(auditText(line({ result: 'lost', reason: ['slept'] }))).toBe('ci · darwin daemon · lost (this Mac slept) · re-run if allowed');
    expect(auditText(line({ result: 'lost', reason: ['slept'] }), false)).toBe('ci · darwin daemon · lost (this Mac slept)');
    expect(auditText(line({ result: 'stopped', reason: ['maxJobTime'] }))).toBe('ci · darwin daemon · stopped at the max job time · VM deleted');
    expect(auditText(line({ result: 'failedToStart', workflow: null, job: null }))).toBe('A VM failed to start');
    expect(auditText(line({ result: 'notRemoved', workflow: null, job: null, reason: ['runner 77 (nekko-mac1-1-0) in group g (id 9) at https://gitlab.com could not be removed; delete it by hand'] }))).toBe('runner 77 (nekko-mac1-1-0) in group g (id 9) at https://gitlab.com could not be removed; delete it by hand');
    expect(auditText(line({ result: 'stopped', reason: ['bootTimeout'] }))).toBe('ci · darwin daemon · stopped after 2 min (the VM never started) · VM deleted');
    expect(auditText(line({ result: 'stopped', reason: ['idle'] }))).toBe('ci · darwin daemon · stopped after 2 min (idle too long) · VM deleted');
    expect(auditText(line({ result: 'lost', reason: ['signal'] }))).toBe('ci · darwin daemon · lost (the daemon stopped it) · re-run if allowed');
    expect(auditText(line({ result: 'lost', reason: ['removed'] }))).toBe('ci · darwin daemon · lost (the runner was removed) · re-run if allowed');
    // The supervisor writes free-form error text as a reason: show it, bounded, not a generic phrase.
    expect(auditText(line({ result: 'stopped', reason: ['clone failed: disk full'] }))).toBe('ci · darwin daemon · stopped after 2 min (clone failed: disk full) · VM deleted');
    expect(auditText(line({ result: 'stopped', reason: ['x'.repeat(200)] }))).toBe(`ci · darwin daemon · stopped after 2 min (${'x'.repeat(79)}…) · VM deleted`);
    expect(auditText(line({ result: 'stopped', reason: ['memoryCritical'] }))).toContain('(memory is critically low)');
  });

  it('names the network with its trust state', () => {
    const h = (over: Partial<HostView>) => ({ ...host, ...over });
    expect(networkText(h({}))).toBe('Unknown');
    expect(networkText(h({ networkId: 'gw:aa:bb:cc:dd:ee:01', networkTrusted: true }))).toBe('Trusted · router dd:ee:01');
    expect(networkText(h({ networkId: 'gw:aa:bb:cc:dd:ee:01' }))).toBe('Not trusted · router dd:ee:01');
    expect(networkText(h({ networkId: 'odd' }))).toBe('Not trusted · odd');
  });

  it('recommends memory in whole GB', () => {
    expect(recommendationText({ ...host, recommendedMemoryMb: 24576 })).toBe('Recommended: 24 GB for this Mac');
    // Before the first sample the host is all zeros: no "0 GB".
    expect(recommendationText(host)).toBe('');
  });

  it('counts VMs and keep-awake across runners', () => {
    const a = view({ slots: [slot('ready')], awake: true });
    const b = view({ slots: [slot('running'), slot('starting')] });
    expect(runnerActivity([a, b])).toEqual({ vms: 3, awake: true });
    expect(runnerActivity([])).toEqual({ vms: 0, awake: false });
  });

  it('builds a connect request', () => {
    const f: ConnectForm = { appId: '123', installationId: '456', privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----', kind: 'org', target: 'acme', repos: 'api, acme/web', allowPublic: false, label: '', priority: 'balanced' };
    expect(toConnectRequest(f, false)).toEqual({ provider: 'github', scope: { kind: 'org', org: 'acme' }, appId: 123, installationId: 456, privateKeyPem: f.privateKeyPem, repos: ['acme/api', 'acme/web'], allowPublic: false, label: 'nekko-cloud-mac' });
    expect(toConnectRequest({ ...f, kind: 'repo', target: 'o/r', repos: 'ignored' }, false)).toMatchObject({ scope: { kind: 'repo', owner: 'o', repo: 'r' }, repos: [] });

    const err = (over: Partial<ConnectForm>, keyStored = false) => toConnectRequest({ ...f, ...over }, keyStored);
    expect(err({ appId: 'abc' })).toEqual({ error: 'The App ID is a number.' });
    expect(err({ installationId: '' })).toEqual({ error: 'The installation ID is a number.' });
    expect(err({ appId: '0' })).toEqual({ error: 'The App ID is a number above 0.' });
    expect(err({ installationId: '00' })).toEqual({ error: 'The installation ID is a number above 0.' });
    expect(err({ privateKeyPem: '' })).toEqual({ error: "Paste the app's private key." });
    const stored = err({ privateKeyPem: '' }, true);
    expect(stored).not.toHaveProperty('error');
    expect(stored).not.toHaveProperty('privateKeyPem');
    expect(err({ privateKeyPem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----' })).toEqual({ error: 'Paste the key as GitHub downloads it (BEGIN RSA PRIVATE KEY).' });
    expect(err({ kind: 'repo', target: 'nope' })).toEqual({ error: 'Enter the repo as owner/name.' });
    expect(err({ repos: '' })).toEqual({ error: 'Pick at least one repo in the org.' });
    expect(err({ label: 'has space' })).toEqual({ error: 'Labels use letters, digits, dot, dash and underscore.' });
    expect(toConnectRequest({ ...f, label: 'studio.m2' }, false)).toMatchObject({ label: 'studio.m2' });
  });
});

describe('todayText', () => {
  it('counts jobs in words people read', () => {
    expect(todayText({ jobs: 0, seconds: 0 })).toBe('No jobs yet');
    expect(todayText({ jobs: 1, seconds: 600 })).toBe('1 job · 10 min');
    expect(todayText({ jobs: 14, seconds: 7800 })).toBe('14 jobs · 2 h 10 min');
  });
});

describe('settingsPatch', () => {
  it('sends only what the owner changed, arrays by value', () => {
    const base = { ...DEFAULT_RUNNER_SETTINGS, trustedNetworks: ['gw:a'] };
    expect(settingsPatch(base, { ...base, trustedNetworks: ['gw:a'] })).toEqual({});
    expect(settingsPatch(base, { ...base, maxJobMinutes: 30, trustedNetworks: ['gw:a', 'gw:b'] })).toEqual({ maxJobMinutes: 30, trustedNetworks: ['gw:a', 'gw:b'] });
    expect(settingsPatch(base, { ...base, cpusPerVm: 4 })).toEqual({ cpusPerVm: 4 });
    expect(settingsPatch({ ...base, cpusPerVm: 4 }, { ...base, cpusPerVm: null })).toEqual({ cpusPerVm: null });
  });
});

describe('runnerWorkflowPrompt', () => {
  const tail = (label: string) => [
    "Read the workflows, then ask me which ones should run on this Mac. Offer only jobs that can run on macOS, and warn me about any that run on pull requests from forks. If the repo isn't in this folder, ask me where it is.",
    '',
    `Set \`runs-on: [self-hosted, macOS, ARM64, ${label}]\` on the ones I pick, and open a pull request.`,
  ];

  it('writes frame 9 for a repo runner', () => {
    expect(runnerWorkflowPrompt(view()).split('\n')).toEqual([
      'Connect my Mac runner to my GitHub Actions workflows.',
      '',
      'Runner label: `nekko-cloud-mac`',
      'Repos: `nekko-labs/nekko-agent`',
      '',
      ...tail('nekko-cloud-mac'),
    ]);
  });

  it('lists an org runner\'s repos', () => {
    const org = view({
      config: { id: 'r2', scope: { kind: 'org', org: 'nekko-labs' }, label: 'mine', settings: DEFAULT_RUNNER_SETTINGS },
      repos: ['nekko-labs/app', 'nekko-labs/site'],
    });
    expect(runnerWorkflowPrompt(org).split('\n')).toEqual([
      'Connect my Mac runner to my GitHub Actions workflows.',
      '',
      'Runner label: `mine`',
      'Repos: `nekko-labs/app`, `nekko-labs/site`',
      '',
      ...tail('mine'),
    ]);
  });
});

describe('image progress', () => {
  const image = (over: Partial<ImageView>): ImageView => ({
    state: 'building', stage: 'download', doneStages: ['check'], detail: '', bytes: null, fraction: null, error: null, log: null, info: null, canResume: false, ...over,
  });
  const marks = (v: ImageView) => imageStageRows(v).map((r) => r.mark);

  it('lists the six stages a person follows', () => {
    expect(imageStageRows(image({})).map((r) => r.label)).toEqual(['Check this Mac', 'Download macOS', 'Install macOS', 'Add Xcode and tools', 'Lock the VM down', 'Test a boot']);
  });

  it('marks each stage of a running build', () => {
    expect(marks(image({ bytes: [12_400_000_000, 25_600_000_000] }))).toEqual(['done', 'now', 'todo', 'todo', 'todo', 'todo']);
    expect(imageStageRows(image({ bytes: [12_400_000_000, 25_600_000_000] }))[1].note).toBe('12.4 of 25.6 GB');
    expect(imageStageRows(image({ stage: 'install', fraction: 0.5 }))[2].note).toBe('50%');
    expect(imageStageRows(image({ stage: 'xcode', detail: 'Downloading the iOS simulator' }))[3].note).toBe('Downloading the iOS simulator');
  });

  it('a wait counts the stage before it as done and drops the old numbers', () => {
    // The daemon names the next stage before it lists the last one as done, and keeps its bytes.
    const v = image({ state: 'waiting', stage: 'install', doneStages: ['check'], bytes: [9, 9], detail: 'Waiting for power: plug this Mac in' });
    expect(marks(v)).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo']);
    expect(imageStageRows(v)[2].note).toBe('Waiting');
    expect(imageFraction(v)).toBeNull();
    expect(imageLine(v)).toBe('Install macOS: Waiting for power: plug this Mac in');
  });

  it('a failed stage is marked bad', () => {
    const v = image({ state: 'failed', stage: 'xcode', doneStages: ['check', 'download', 'install'], error: 'No room.' });
    expect(marks(v)).toEqual(['done', 'done', 'done', 'bad', 'todo', 'todo']);
    expect(imageLine(v)).toBe('Setup stopped: No room.');
  });

  it('a build at rest is paused on its next stage', () => {
    const v = image({ state: 'none', stage: 'xcode', doneStages: ['check', 'download', 'install'], canResume: true });
    expect(imageStageRows(v)[3]).toMatchObject({ mark: 'now', note: 'Paused' });
  });

  it('the bar follows bytes, then the install fraction, and nothing else', () => {
    expect(imageFraction(image({ bytes: [1, 4] }))).toBe(0.25);
    expect(imageFraction(image({ bytes: [0, 0] }))).toBeNull();
    expect(imageFraction(image({ stage: 'install', fraction: 0.5 }))).toBe(0.5);
    expect(imageFraction(image({ stage: 'xcode' }))).toBeNull();
  });

  it('every stage is done at Finish', () => {
    expect(marks(image({ stage: 'finish', doneStages: ['check', 'download', 'install', 'xcode', 'lockdown', 'test'] }))).toEqual(Array(6).fill('done'));
  });
});

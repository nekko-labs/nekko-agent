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
  acceptBlocked,
  auditText,
  auditTimeline,
  formatMinutes,
  githubActionsSettingsUrl,
  imageFraction,
  imageLine,
  imageStageRows,
  missingToolsLine,
  settingsPatch,
  todayText,
  reasonText,
  networkText,
  recommendationText,
  suggestedSizeRow,
  runnerActivity,
  runnerSubtitle,
  runnerTitle,
  runnerWorkflowPrompt,
  slotLimitText,
  slotLines,
  stepText,
  toConnectRequest,
  waitingText,
  type AuditLine,
  type ConnectForm,
  type HostView,
  type ImageView,
  type RunnerView,
  type SlotView,
  readyVms,
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
  today: { jobs: 0, seconds: 0 }, host, repos: [], forkApprovalOpen: false, recent: [], suggestedSize: null,
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

  it("reads ready VMs like the daemon: the owner's count, else the mode's", () => {
    expect(readyVms({ priority: 'doNotDisturb', readyVms: null })).toBe(0);
    expect(readyVms({ priority: 'balanced' })).toBe(1);
    expect(readyVms({ priority: 'runnerFirst', readyVms: null })).toBe(2);
    expect(readyVms({ priority: 'doNotDisturb', readyVms: 1 })).toBe(1);
    expect(readyVms({ priority: 'balanced', readyVms: 5 })).toBe(2);
  });

  it('titles a runner like the mockup', () => {
    const v = view();
    expect(runnerTitle(v)).toBe('This Mac · GitHub · nekko-labs/nekko-agent');
    expect(runnerSubtitle(v)).toBe("repo scope · label nekko-cloud-mac · Balanced: in the background · While a runner is active");
    expect(runnerTitle(view({ config: { ...v.config, scope: { kind: 'org', org: 'acme' } } }))).toBe('This Mac · GitHub · acme');
  });

  it('slot_lines_grey_out_slots_past_available', () => {
    const job = { repo: 'nekko-labs/nekko-agent', runId: 1, jobId: 2, workflow: 'ios-native', job: 'PR #904' };
    const v = view({ available: 1, limit: 'otherApps', state: 'running', slots: [slot('running', { job, since: now - 360 })] }, { macosSlots: 2, maxJobMinutes: 120 });
    expect(slotLines(v, now)).toEqual([
      { title: 'Slot 1 · macOS', text: 'ios-native · PR #904 · 6 min', active: true, dim: false },
      { title: 'Slot 2 · macOS', text: 'Not available: Another app is running a macOS VM.', active: false, dim: true },
    ]);

    const waiting = slotLines(view({ available: 2, reasons: ['userActive'] }, { macosSlots: 2 }), now);
    expect(waiting.map((l) => [l.text, l.dim])).toEqual([["Waiting: you're using the Mac", false], ["Waiting: you're using the Mac", false]]);

    const states = view({ available: 4, slots: [slot('starting'), slot('ready'), slot('draining', { drainEndsAt: now + 90 }), slot('cleaning')] }, { macosSlots: 4 });
    expect(slotLines(states, now).map((l) => l.text)).toEqual(['Starting a VM', 'Ready for a job', 'Finishing, stops in 2 min', 'Deleting the VM']);

    expect(slotLines(view(), now).map((l) => l.text)).toEqual(['Starts a VM when a job is queued']);
    expect(slotLines(view({ state: 'error', error: 'No VM image yet.' }), now).map((l) => l.text)).toEqual(['Stopped until the error above is fixed']);
    // A bound with no name still greys the slot with a sentence.
    expect(slotLines(view({ available: 0 }), now)[0]).toEqual({ title: 'Slot 1 · macOS', text: 'Not available: Fewer slots are available right now.', active: false, dim: true });
  });

  it('says how far a running job has got from its steps', () => {
    expect(stepText({ done: 6, total: 12, current: 'Build iOS' })).toEqual({ text: 'Step 7 of 12: Build iOS · 50%', fraction: 0.5 });
    expect(stepText({ done: 1, total: 3, current: null })?.text).toBe('Step 2 of 3 · 33%');
    expect(stepText({ done: 4, total: 4, current: null })).toEqual({ text: 'All 4 steps done · 100%', fraction: 1 });
    // GitLab, an older daemon, or a job not yet set up: no made-up percent.
    expect(stepText(undefined)).toBeNull();
    expect(stepText({ done: 0, total: 0, current: null })).toBeNull();
  });

  it('says how long a queued job has waited', () => {
    expect(waitingText(new Date((now - 180) * 1000).toISOString(), now)).toBe('waiting 3 min');
    expect(waitingText(null, now)).toBe('waiting');
    expect(waitingText('not a date', now)).toBe('waiting');
  });

  it('says why Accept now cannot start a VM', () => {
    const on = { enabled: true };
    expect(acceptBlocked(view({ acceptWhy: [] }, on))).toBeNull();
    expect(acceptBlocked(view({ acceptWhy: ['thermalCritical'] }, on))).toBe(REASONS.thermalCritical.sentence);
    expect(acceptBlocked(view({ error: 'No VM image yet.' }, on))).toBe('Fix the error above first.');
    expect(acceptBlocked(view({}, { enabled: false }))).toBe('Turn the runner on first.');
  });

  it('linux_slots_follow_the_macos_ones_and_say_why_they_wait', () => {
    const job = { repo: 'o/r', runId: 1, jobId: 2, workflow: 'ci', job: 'server tests' };
    const v = view(
      { available: 1, linuxAvailable: 1, slots: [slot('ready'), slot('running', { guest: 'linux', job, since: now - 60 })] },
      { macosSlots: 1, linuxSlots: 2 },
    );
    expect(slotLines(v, now).map((l) => [l.title, l.text, l.dim])).toEqual([
      ['Slot 1 · macOS', 'Ready for a job', false],
      ['Slot 2 · Linux', 'ci · server tests · 1 min', false],
      ['Slot 3 · Linux', 'Not available: the memory macOS slots leave is used up.', true],
    ]);
    // A Linux VM never fills a macOS tile, whatever order the daemon lists them in.
    const first = view({ available: 1, linuxAvailable: 1, slots: [slot('starting', { guest: 'linux' })] }, { macosSlots: 1, linuxSlots: 1 });
    expect(slotLines(first, now).map((l) => l.text)).toEqual(['Starts a VM when a job is queued', 'Starting a VM']);
    const none = view({ linuxAvailable: 0, linuxError: 'No Linux image yet.' }, { macosSlots: 0, linuxSlots: 1 });
    expect(slotLines(none, now)).toEqual([{ title: 'Slot 1 · Linux', text: 'Not available: No Linux image yet.', active: false, dim: true }]);
    // An older daemon sends neither field: no Linux tiles beyond the setting, all unavailable.
    expect(slotLines(view({}, { linuxSlots: 0 }), now)).toHaveLength(1);
  });

  it('describes recent jobs', () => {
    const line = (over: Partial<AuditLine>): AuditLine => ({ ts: now, runnerId: 'r', repo: 'o/r', workflow: 'ci', job: 'darwin daemon', result: 'finished', seconds: 120, reason: [], ...over });
    expect(auditText(line({ workflow: 'mobile', job: 'iOS build', seconds: 660 }))).toBe('mobile · iOS build · finished · 11 min');
    expect(auditText(line({ result: 'stopped', reason: ['userBusy'] }))).toBe('ci · darwin daemon · stopped after 2 min (your apps are busy)');
    // AuditLine does not say whether that job was re-run; only the current setting is known.
    expect(auditText(line({ result: 'lost', reason: ['slept'] }))).toBe('ci · darwin daemon · lost (this Mac slept) · re-run if allowed');
    expect(auditText(line({ result: 'lost', reason: ['slept'] }), false)).toBe('ci · darwin daemon · lost (this Mac slept)');
    expect(auditText(line({ result: 'stopped', reason: ['maxJobTime'] }))).toBe('ci · darwin daemon · stopped at the max job time');
    expect(auditText(line({ result: 'failedToStart', workflow: null, job: null }))).toBe('A VM failed to start');
    expect(auditText(line({ result: 'notRemoved', workflow: null, job: null, reason: ['runner 77 (nekko-mac1-1-0) in group g (id 9) at https://gitlab.com could not be removed; delete it by hand'] }))).toBe('runner 77 (nekko-mac1-1-0) in group g (id 9) at https://gitlab.com could not be removed; delete it by hand');
    expect(auditText(line({ result: 'stopped', reason: ['bootTimeout'] }))).toBe('ci · darwin daemon · stopped after 2 min (the VM never started)');
    expect(auditText(line({ result: 'stopped', reason: ['idle'] }))).toBe('ci · darwin daemon · stopped after 2 min (idle too long)');
    expect(auditText(line({ result: 'lost', reason: ['signal'] }))).toBe('ci · darwin daemon · lost (the daemon stopped it) · re-run if allowed');
    expect(auditText(line({ result: 'lost', reason: ['removed'] }))).toBe('ci · darwin daemon · lost (the runner was removed) · re-run if allowed');
    // The supervisor writes free-form error text as a reason: show it, bounded, not a generic phrase.
    expect(auditText(line({ result: 'stopped', reason: ['clone failed: disk full'] }))).toBe('ci · darwin daemon · stopped after 2 min (clone failed: disk full)');
    expect(auditText(line({ result: 'stopped', reason: ['x'.repeat(200)] }))).toBe(`ci · darwin daemon · stopped after 2 min (${'x'.repeat(79)}…)`);
    expect(auditText(line({ result: 'stopped', reason: ['memoryCritical'] }))).toContain('(memory is critically low)');
  });

  it('tells a recent job step by step', () => {
    const line = (over: Partial<AuditLine>): AuditLine => ({ ts: 1000, runnerId: 'r', repo: 'o/r', workflow: 'ci', job: 'build', result: 'finished', seconds: 120, reason: [], ...over });
    const events = [{ ts: 700, state: 'starting' as const }, { ts: 760, state: 'ready' as const }, { ts: 800, state: 'running' as const }];
    expect(auditTimeline(line({ events }))).toEqual([
      { ts: 700, text: 'Starting a VM' },
      { ts: 760, text: 'VM online, waiting for a job' },
      { ts: 800, text: 'Running the job' },
      { ts: 1000, text: 'The job finished and the VM powered off; VM deleted' },
    ]);
    // An older daemon's line has no events: the end is still told.
    expect(auditTimeline(line({ result: 'stopped', reason: ['slept'] }))).toEqual([{ ts: 1000, text: 'Stopped (this Mac slept); VM deleted' }]);
    expect(auditTimeline(line({ result: 'failedToStart', reason: ['it powered off before its runner connected'] }))[0].text)
      .toBe('The VM failed to start (it powered off before its runner connected); VM deleted');
    expect(auditTimeline(line({ result: 'notRemoved' }))).toEqual([]);
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

  it('shows the suggested size, and Apply only when it differs', () => {
    const at = (s: RunnerView['suggestedSize']) => suggestedSizeRow(view({ host: { ...host, cpusPerVm: 6 }, suggestedSize: s }, { memoryPerVmMb: 10240 }));
    expect(at(null)).toBeNull();
    expect(at({ jobs: 1, cpus: 6, memoryMb: 10240, reasons: [] })).toEqual({ line: 'Suggested size after 3 jobs at this size (1 so far).', reasons: [], apply: null });
    expect(at({ jobs: 4, cpus: 6, memoryMb: 10240, reasons: [] })).toEqual({ line: 'Fits your last 4 jobs.', reasons: [], apply: null });
    const why = ['The biggest job used 5.4 GB at most and never swapped.'];
    expect(at({ jobs: 4, cpus: 6, memoryMb: 8192, reasons: why })).toEqual({
      line: 'Suggested for your jobs: 6 vCPUs, 8 GB (now 6 vCPUs, 10 GB).',
      reasons: why,
      apply: { cpusPerVm: 6, memoryPerVmMb: 8192 },
    });
  });

  it('counts VMs and keep-awake across runners', () => {
    const a = view({ slots: [slot('ready')], awake: true });
    const b = view({ slots: [slot('running'), slot('starting')] });
    expect(runnerActivity([a, b])).toEqual({ vms: 3, awake: true });
    expect(runnerActivity([])).toEqual({ vms: 0, awake: false });
  });

  it('builds a connect request', () => {
    const f: ConnectForm = { appId: '123', installationId: '456', privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----', kind: 'org', target: 'acme', repos: 'api, acme/web', allowPublic: false, label: '', priority: 'balanced', readyVms: 1 };
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
    state: 'building', kind: 'xcode', stage: 'download', doneStages: ['check'], detail: '', bytes: null, fraction: null, error: null, log: null, info: null, canResume: false, ...over,
  });
  const marks = (v: ImageView) => imageStageRows(v).map((r) => r.mark);

  it('lists the six stages a person follows', () => {
    expect(imageStageRows(image({})).map((r) => r.label)).toEqual(['Check this Mac', 'Download the macOS image', 'Install the macOS VM', 'Add Xcode and tools', 'Lock the VM down', 'Test a boot']);
  });

  it('a refresh lists only its own stages', () => {
    const v = image({ kind: 'refresh', stage: 'scripts', doneStages: ['check'], detail: 'Writing the new scripts into the copy' });
    expect(imageStageRows(v).map((r) => r.label)).toEqual(['Check this Mac', "Update Nekko's scripts", 'Test a boot']);
    expect(marks(v)).toEqual(['done', 'now', 'todo']);
    // No build at all lists a full one.
    expect(imageStageRows(image({ kind: null, state: 'none', stage: null, doneStages: [] }))).toHaveLength(6);
  });

  it('adding tools lists only its own stages', () => {
    const v = image({ kind: 'tools', stage: 'tools', doneStages: ['check'], detail: 'Installing node, gh and jq' });
    expect(imageStageRows(v).map((r) => r.label)).toEqual(['Check this Mac', 'Install the missing tools', 'Test a boot']);
    expect(marks(v)).toEqual(['done', 'now', 'todo']);
    expect(imageLine(v)).toBe('Install the missing tools: Installing node, gh and jq');
  });

  it('names the missing tools in a plain sentence', () => {
    expect(missingToolsLine(['node', 'gh'])).toBe("node and gh are missing from this Mac's runner image. Jobs that need them will fail.");
    expect(missingToolsLine(['node', 'gh', 'jq'])).toBe("node, gh and jq are missing from this Mac's runner image. Jobs that need them will fail.");
    expect(missingToolsLine(['gh'])).toBe("gh is missing from this Mac's runner image. Jobs that need it will fail.");
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
    expect(imageLine(v)).toBe('Install the macOS VM: Waiting for power: plug this Mac in');
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

it('links to the Actions settings of a repo or an org', () => {
  expect(githubActionsSettingsUrl({ kind: 'repo', owner: 'o', repo: 'r' })).toBe('https://github.com/o/r/settings/actions');
  expect(githubActionsSettingsUrl({ kind: 'org', org: 'acme' })).toBe('https://github.com/organizations/acme/settings/actions');
});

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_RUNNER_SETTINGS, IDLE_GITHUB_SETUP, MAX_RUNNER_REPOS, PRIORITY_DESCRIPTIONS, PRIORITY_LABELS, defaultRepoPicks, tickRepo, toSetupRequest, type ConnectForm, type GithubAccounts, type GithubRepo, type GithubSetupView, type RunnerView } from '@nekko-agent/shared';

vi.mock('./primitives/index.js', async (original) => ({
  ...await original<typeof import('./primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

import { AccountStep, ConfirmStep, ConnectBody, ForkStep, ModeStep, WaitingStep, confirmFork, emptyConnectForm, sheetScreen, stepError, submitConnect, submitSetup, type AccountChoice } from './ConnectRunnerSheet.js';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----';
const form = (over: Partial<ConnectForm> = {}): ConnectForm => ({
  ...emptyConnectForm(), appId: '12', installationId: '34', privateKeyPem: PEM, kind: 'repo', target: 'nekko-labs/nekko-agent', ...over,
});
const view: RunnerView = {
  config: { id: 'r1', scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' }, label: 'nekko-cloud-mac', settings: { ...DEFAULT_RUNNER_SETTINGS } },
  state: 'off', slots: [], reasons: [], available: 0, limit: null, awake: false, error: null, today: { jobs: 0, seconds: 0 },
  host: { ramMb: 0, cores: 0, recommendedMemoryMb: 0, runnerMemoryMb: 0, cpusPerVm: 0, onBattery: null, batteryPct: null, networkId: null, networkTrusted: false },
  recent: [],
};
const body = (step: 1 | 2 | 3, f: ConnectForm, error: string | null = null) =>
  renderToStaticMarkup(<ConnectBody step={step} form={f} error={error} busy={false} onField={() => {}} onStep={() => {}} onSubmit={() => {}} />);

describe('ConnectRunnerSheet', () => {
  it('steps_match_mockup_2', () => {
    const html = body(3, form());
    for (const s of ['1 Install app', '2 Org or repo', '3 How this Mac helps', 'How should this Mac help?', 'You can change this any time.', 'Start runner']) expect(html).toContain(s);
    for (const p of ['doNotDisturb', 'balanced', 'runnerFirst'] as const) {
      expect(html).toContain(renderToStaticMarkup(<>{PRIORITY_LABELS[p]}</>));
      expect(html).toContain(renderToStaticMarkup(<>{PRIORITY_DESCRIPTIONS[p]}</>));
    }
    const callout = 'may be public. Keep &quot;Require approval for all external contributors&quot; on';
    expect(body(3, form({ allowPublic: true }))).toContain(`nekko-labs/nekko-agent ${callout}`);
    expect(html).not.toContain(callout);
  });

  it('step_1_and_2_show_their_fields', () => {
    const one = body(1, form());
    for (const s of ['App ID', 'Installation ID', 'Private key', 'How to create the app', 'https://nekkoagent.com/docs/ci-runners#create-the-github-app']) expect(one).toContain(s);
    const two = body(2, form({ kind: 'org', target: 'nekko-labs' }));
    for (const s of ['A repo', 'An org', 'Repos in the org', 'Allow public repos', 'Runner label', 'placeholder="nekko-cloud-mac"', 'runs-on: [self-hosted, macOS, ARM64, nekko-cloud-mac]']) expect(two).toContain(s);
  });

  it('step_1_hides_the_key', () => {
    const one = body(1, form());
    expect(one).toMatch(/<textarea[^>]*autoComplete="off"|<textarea[^>]*autocomplete="off"/);
    expect(one).toMatch(/<textarea[^>]*spellCheck="false"|<textarea[^>]*spellcheck="false"/);
    for (const step of [2, 3] as const) expect(body(step, form())).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('connect_error_shows_inline_and_never_echoes_the_key', async () => {
    const sentence = 'GitHub refused this app key. It may have been revoked; connect again with a new key.';
    const pushToast = vi.fn();
    const res = await submitConnect(form(), { connectRunner: () => Promise.reject(new Error(sentence)), updateRunner: vi.fn(), pushToast });
    expect(res).toEqual({ error: sentence, step: 3 });
    expect(pushToast).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(body(3, form(), sentence)).toMatch(/role="alert"[^>]*>GitHub refused this app key/);
  });

  it('validation_error_returns_to_the_step_that_owns_the_field', async () => {
    const deps = { connectRunner: vi.fn(), updateRunner: vi.fn(), pushToast: vi.fn() };
    expect(await submitConnect(form({ appId: '0' }), deps)).toEqual({ error: 'The App ID is a number above 0.', step: 1 });
    expect(await submitConnect(form({ target: 'nope' }), deps)).toEqual({ error: 'Enter the repo as owner/name.', step: 2 });
    expect(deps.connectRunner).not.toHaveBeenCalled();
  });

  it('connect_sets_the_priority_after_connecting', async () => {
    const connectRunner = vi.fn(async () => view);
    const updated = { ...view, config: { ...view.config, settings: { ...view.config.settings, priority: 'runnerFirst' as const } } };
    const updateRunner = vi.fn(async () => updated);
    const res = await submitConnect(form({ priority: 'runnerFirst' }), { connectRunner, updateRunner, pushToast: vi.fn() });
    expect(connectRunner).toHaveBeenCalledTimes(1);
    expect(updateRunner).toHaveBeenCalledWith('r1', { priority: 'runnerFirst' });
    expect(res).toEqual({ view: updated, form: emptyConnectForm() });

    const update2 = vi.fn();
    await submitConnect(form({ priority: 'doNotDisturb' }), { connectRunner, updateRunner: update2, pushToast: vi.fn() });
    expect(update2).not.toHaveBeenCalled();
  });

  it('a_failed_mode_update_still_connects', async () => {
    const pushToast = vi.fn();
    const res = await submitConnect(form({ priority: 'balanced' }), {
      connectRunner: async () => view, updateRunner: () => Promise.reject(new Error('The daemon is busy.')), pushToast,
    });
    expect(res).toEqual({ view, form: emptyConnectForm() });
    expect(pushToast).toHaveBeenCalledWith('error', 'Connected, but could not set the mode: The daemon is busy.');
    expect(JSON.stringify(pushToast.mock.calls)).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('next_checks_only_the_step_being_left', () => {
    expect(stepError(form({ appId: 'x', target: '' }), 1)).toBe('The App ID is a number.');
    expect(stepError(form({ target: '' }), 1)).toBeNull();
    expect(stepError(form({ target: '' }), 2)).toBe('Enter the repo as owner/name.');
    expect(stepError(form(), 2)).toBeNull();
  });

  it('closing_clears_the_key', async () => {
    expect(emptyConnectForm().privateKeyPem).toBe('');
    const res = await submitConnect(form(), { connectRunner: async () => view, updateRunner: vi.fn(), pushToast: vi.fn() });
    expect(res).toEqual({ view, form: emptyConnectForm() });
  });

  it('no_em_dash_in_markup', () => {
    for (const step of [1, 2, 3] as const) expect(body(step, form({ allowPublic: true }))).not.toContain('\u2014');
  });
});

const repo = (name: string, priv = true): GithubRepo => ({ name, private: priv });
const setup = (over: Partial<GithubSetupView> = {}): GithubSetupView => ({
  ...IDLE_GITHUB_SETUP, step: 'confirm', owner: 'nekko-labs', kind: 'org', slug: 'nekko-runner-3fa9', appId: 12, installationId: 34,
  repos: [repo('nekko-labs/app'), repo('nekko-labs/site')], ...over,
});
const accounts: GithubAccounts = { login: 'ermish', accounts: [
  { login: 'nekko-labs', kind: 'org', canGroup: true },
  { login: 'free-org', kind: 'org', canGroup: false },
  { login: 'ermish', kind: 'user', canGroup: null },
] };
const account = (over: Partial<GithubAccounts> = {}, choice: AccountChoice = { login: 'nekko-labs', kind: 'org', canGroup: true }) =>
  renderToStaticMarkup(<AccountStep accounts={{ ...accounts, ...over }} choice={choice} error={null} busy={false} onChoice={() => {}} onContinue={() => {}} onManual={() => {}} />);
const confirm = (status: GithubSetupView, picked: string[], allowPublic = false) =>
  renderToStaticMarkup(<ConfirmStep status={status} picks={{ repos: picked, allowPublic, label: '' }} error={null} busy={false} onTick={() => {}} onAllowPublic={() => {}} onLabel={() => {}} onContinue={() => {}} onRecheck={() => {}} onCancel={() => {}} />);
/** The named button's opening tag. */
const button = (html: string, name: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${name}`))?.[0] ?? '';

describe('ConnectRunnerSheet GitHub steps', () => {
  it('account_step_lists_what_gh_knows', () => {
    const html = account();
    for (const s of ['Where do your repos live?', 'nekko-labs', 'Organization', 'ermish', 'Your account', 'Another account', 'Type its name', 'Continue on GitHub', 'Use an app I already have']) expect(html).toContain(s);
  });

  it('account_step_is_one_text_box_without_gh', () => {
    const html = account({ login: null, accounts: [] }, { login: '', kind: 'org', canGroup: null, typed: true });
    expect(html).not.toContain('Another account');
    expect(html).toContain('GitHub account or org');
    expect(button(html, 'Continue on GitHub')).toContain('disabled=""');
    expect(button(account({ login: null, accounts: [] }, { login: 'acme', kind: 'org', canGroup: null, typed: true }), 'Continue on GitHub')).not.toContain('disabled=""');
  });

  it('a_free_org_gets_the_single_repo_offer_before_anything_is_created', () => {
    const html = account({}, { login: 'free-org', kind: 'org', canGroup: false });
    expect(html).toContain('runner groups');
    expect(html).toContain('Connect one repo on GitHub');
    expect(html).not.toContain('Continue on GitHub');
    expect(account()).not.toContain('Connect one repo on GitHub');
  });

  it('an_org_whose_plan_cannot_be_seen_can_still_ask_for_one_repo', () => {
    const offer = 'On the Free plan? Connect one repo instead';
    expect(account({ login: null, accounts: [] }, { login: 'acme', kind: 'org', canGroup: null, typed: true })).toContain(offer);
    expect(account({}, { login: 'hidden-plan', kind: 'org', canGroup: null })).toContain(offer);
    expect(account({ login: null, accounts: [] }, { login: '', kind: 'org', canGroup: null, typed: true })).not.toContain(offer);
    expect(account({}, { login: 'ermish', kind: 'user', canGroup: null })).not.toContain(offer);
    expect(account()).not.toContain(offer);
    expect(account({}, { login: 'free-org', kind: 'org', canGroup: false })).not.toContain(offer);
  });

  it('waiting_step_shows_where_the_setup_is', () => {
    const wait = (step: 'create' | 'install') => renderToStaticMarkup(<WaitingStep status={setup({ step })} busy={false} onCancel={() => {}} onOpen={() => {}} />);
    for (const s of ['Finish on GitHub', 'Create the app', 'Choose repos and click Install', 'This updates by itself.', 'Cancel', 'Open GitHub again']) expect(wait('install')).toContain(s);
    expect(wait('install')).toMatch(/Create the app.*Done.*Choose repos and click Install.*Waiting/s);
    expect(wait('create')).toMatch(/Create the app.*Waiting.*Choose repos and click Install(?!.*Waiting)/s);
    expect(wait('create')).toContain('If signing in left you on an empty form, close it and choose Open GitHub again.');
    expect(wait('install')).not.toContain('empty form');
  });

  it('confirm_step_lists_the_repos', () => {
    const html = confirm(setup(), ['nekko-labs/app']);
    for (const s of ['GitHub is connected', 'This Mac will serve these repos:', 'nekko-labs/app', 'nekko-labs/site', 'Private', 'Add repos on GitHub', 'Advanced: runner label']) expect(html).toContain(s);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(button(html, 'Continue')).not.toContain('disabled=""');
    expect(button(html, 'Cancel')).not.toBe('');
  });

  it('a_personal_account_picks_one_repo_by_radio', () => {
    const v = setup({ kind: 'user', owner: 'ermish', repos: [repo('ermish/a'), repo('ermish/b')] });
    expect(confirm(v, []).match(/type="radio"/g)).toHaveLength(2);
    expect(confirm(v, [])).not.toContain('type="checkbox"');
    expect(defaultRepoPicks(v)).toEqual([]);
    expect(defaultRepoPicks({ ...v, repos: [repo('ermish/a')] })).toEqual(['ermish/a']);
    expect(tickRepo(v, ['ermish/a'], 'ermish/b', true)).toEqual({ picked: ['ermish/b'], error: null });
    expect(toSetupRequest(v, { repos: ['ermish/b'], allowPublic: false, label: '' })).toMatchObject({ scope: { kind: 'repo', owner: 'ermish', repo: 'b' }, repos: [], enabled: true });
  });

  it('a_free_orgs_app_serves_one_repo_too', () => {
    const v = setup({ repoAdmin: true });
    expect(confirm(v, []).match(/type="radio"/g)).toHaveLength(2);
    expect(toSetupRequest(v, { repos: ['nekko-labs/app'], allowPublic: false, label: '' })).toMatchObject({ scope: { kind: 'repo', owner: 'nekko-labs', repo: 'app' } });
  });

  it('none_start_ticked_on_an_install_of_more_than_5', () => {
    const many = (n: number) => setup({ repos: Array.from({ length: n }, (_, i) => repo(`nekko-labs/r${i}`)) });
    expect(defaultRepoPicks(many(5))).toHaveLength(5);
    expect(defaultRepoPicks(many(6))).toEqual([]);
  });

  it('a_21st_tick_is_refused', () => {
    const v = setup({ repos: Array.from({ length: 30 }, (_, i) => repo(`nekko-labs/r${i}`)) });
    const twenty = v.repos.slice(0, MAX_RUNNER_REPOS).map((r) => r.name);
    const res = tickRepo(v, twenty, 'nekko-labs/r20', true);
    expect(res.picked).toBe(twenty);
    expect(res.error).toBe('A runner serves at most 20 repos.');
    expect(tickRepo(v, twenty, 'nekko-labs/r0', false).picked).toHaveLength(19);
    expect(toSetupRequest(v, { repos: v.repos.slice(0, 21).map((r) => r.name), allowPublic: false, label: '' })).toEqual({ error: 'A runner serves at most 20 repos.' });
  });

  it('a_public_repo_cannot_continue_without_its_choice', () => {
    const v = setup({ repos: [repo('nekko-labs/app'), repo('nekko-labs/site', false)] });
    const picked = ['nekko-labs/site'];
    const html = confirm(v, picked);
    for (const s of ['Public repo.', 'outside contributors need your approval', 'Require approval for outside contributors', 'Nekko sets this on GitHub for you.', 'Public']) expect(html).toContain(s);
    expect(button(html, 'Continue')).toContain('disabled=""');
    expect(toSetupRequest(v, { repos: picked, allowPublic: false, label: '' })).toEqual({ error: 'Choose how to handle the public repo first.' });
    expect(button(confirm(v, picked, true), 'Continue')).not.toContain('disabled=""');
    expect(toSetupRequest(v, { repos: picked, allowPublic: true, label: '' })).toMatchObject({ allowPublic: true, enabled: false });
    // Only a ticked public repo counts: no warning, and it stays allowed off.
    expect(confirm(v, ['nekko-labs/app'])).not.toContain('Public repo.');
    expect(toSetupRequest(v, { repos: ['nekko-labs/app'], allowPublic: true, label: '' })).toMatchObject({ allowPublic: false, enabled: true });
  });

  it('nothing_ticked_cannot_continue', () => {
    expect(button(confirm(setup(), []), 'Continue')).toContain('disabled=""');
    expect(toSetupRequest(setup(), { repos: [], allowPublic: false, label: '' })).toEqual({ error: 'Pick at least one repo.' });
  });

  it('confirm_builds_an_org_request_that_reuses_the_stored_key', () => {
    const req = toSetupRequest(setup(), { repos: ['nekko-labs/app'], allowPublic: false, label: ' mine ' });
    expect(req).toEqual({ provider: 'github', scope: { kind: 'org', org: 'nekko-labs' }, appId: 12, installationId: 34, repos: ['nekko-labs/app'], allowPublic: false, label: 'mine', enabled: true });
    expect(req).not.toHaveProperty('privateKeyPem');
  });

  it('mode_step_comes_last_and_an_org_with_no_groups_gets_the_way_out', () => {
    const noGroups = 'This org cannot create runner groups. Connect a single repo instead.';
    const mode = (error: string | null) => renderToStaticMarkup(<ModeStep status={setup()} priority="doNotDisturb" error={error} busy={false} onPriority={() => {}} onBack={() => {}} onSubmit={() => {}} />);
    for (const s of ['How should this Mac help?', 'Start runner']) expect(mode(null)).toContain(s);
    expect(mode(null)).not.toContain('Delete the app on GitHub');
    expect(mode(noGroups)).toContain(noGroups);
    expect(mode(noGroups)).toContain('Delete the app on GitHub');
  });

  it('fork_step_links_the_setting_and_keeps_the_runner_off', () => {
    const html = renderToStaticMarkup(<ForkStep url="https://github.com/o/r/settings/actions" busy={false} onOpen={() => {}} onLeaveOff={() => {}} onConfirmed={() => {}} />);
    for (const s of ['the runner stays off', 'Require approval for all external contributors', 'Open Actions settings', 'Leave it off', 'It is on, start the runner']) expect(html).toContain(s);
  });

  it('the_screen_follows_the_daemon_and_the_manual_link', () => {
    const screen = (over: Partial<Parameters<typeof sheetScreen>[0]>) => sheetScreen({ status: IDLE_GITHUB_SETUP, manual: false, moding: false, submitting: false, approval: null, ...over });
    expect(screen({})).toBe('account');
    expect(screen({ manual: true })).toBe('manual');
    expect(screen({ manual: true, status: setup({ step: 'install' }) })).toBe('manual');
    expect(screen({ status: setup({ step: 'create' }) })).toBe('waiting');
    expect(screen({ status: setup({ step: 'install' }) })).toBe('waiting');
    expect(screen({ status: setup() })).toBe('confirm');
    expect(screen({ status: setup(), moding: true })).toBe('mode');
    expect(screen({ status: setup({ step: 'failed', error: 'x' }) })).toBe('account');
    // Connecting ends the daemon's setup, while the sheet still sets the mode and fork approval.
    expect(screen({ submitting: true })).toBe('mode');
    // Connecting ends the daemon's setup; the fork step must outlive that.
    expect(screen({ approval: { done: false, url: 'u', runnerId: 'r1' } })).toBe('fork');
  });

  describe('submitSetup', () => {
    const publicSetup = setup({ repos: [repo('nekko-labs/site', false)] });
    const picks = { repos: ['nekko-labs/site'], allowPublic: true, label: '' };
    const deps = (over = {}) => ({
      connectRunner: vi.fn(async () => view), updateRunner: vi.fn(async () => view), setRunnerEnabled: vi.fn(async () => view),
      setForkApproval: vi.fn(async () => ({ done: true, url: 'u' })), pushToast: vi.fn(), ...over,
    });

    it('a_private_repo_starts_on_and_skips_fork_approval', async () => {
      const d = deps();
      const res = await submitSetup(setup(), { repos: ['nekko-labs/app'], allowPublic: false, label: '' }, 'balanced', d);
      expect(d.connectRunner).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
      expect(d.updateRunner).toHaveBeenCalledWith('r1', { priority: 'balanced' });
      expect(d.setForkApproval).not.toHaveBeenCalled();
      expect(d.setRunnerEnabled).not.toHaveBeenCalled();
      expect(res).toEqual({ view, approval: null });
    });

    it('a_public_repo_connects_off_and_turns_on_once_approval_is_set', async () => {
      const d = deps();
      const res = await submitSetup(publicSetup, picks, 'doNotDisturb', d);
      expect(d.connectRunner).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, allowPublic: true }));
      expect(d.setForkApproval).toHaveBeenCalledWith({ runnerId: 'r1' });
      expect(d.setRunnerEnabled).toHaveBeenCalledWith('r1', true);
      expect(res).toEqual({ view, approval: null });
    });

    it('approval_not_set_leaves_the_runner_off_and_returns_the_link', async () => {
      const d = deps({ setForkApproval: vi.fn(async () => ({ done: false, url: 'https://github.com/o/r/settings/actions' })) });
      const res = await submitSetup(publicSetup, picks, 'doNotDisturb', d);
      expect(d.setRunnerEnabled).not.toHaveBeenCalled();
      expect(res).toEqual({ view, approval: { done: false, url: 'https://github.com/o/r/settings/actions', runnerId: 'r1' } });
    });

    it('a_failed_approval_call_leaves_the_runner_off_and_says_so', async () => {
      const d = deps({ setForkApproval: () => Promise.reject(new Error('The daemon is busy.')) });
      const res = await submitSetup(publicSetup, picks, 'doNotDisturb', d);
      expect(d.setRunnerEnabled).not.toHaveBeenCalled();
      expect(d.pushToast).toHaveBeenCalledWith('error', expect.stringContaining('The daemon is busy.'));
      expect(res).toEqual({ view, approval: null });
    });

    it('a_refused_connect_is_the_daemons_sentence', async () => {
      const d = deps({ connectRunner: () => Promise.reject(new Error('This org cannot create runner groups.')) });
      expect(await submitSetup(setup(), { repos: ['nekko-labs/app'], allowPublic: false, label: '' }, 'doNotDisturb', d)).toEqual({ error: 'This org cannot create runner groups.' });
    });
  });

  it('saying_approval_is_on_settles_it_before_starting_the_runner', async () => {
    const calls: string[] = [];
    const deps = {
      setForkApproval: vi.fn(async () => { calls.push('settle'); return { done: true, url: '' }; }),
      setRunnerEnabled: vi.fn(async () => { calls.push('enable'); return view; }),
    };
    expect(await confirmFork('r1', deps)).toBe(view);
    expect(deps.setForkApproval).toHaveBeenCalledWith({ runnerId: 'r1', confirmed: true });
    expect(deps.setRunnerEnabled).toHaveBeenCalledWith('r1', true);
    expect(calls).toEqual(['settle', 'enable']);
  });

  it('no_em_dash_in_the_new_steps', () => {
    const wait = renderToStaticMarkup(<WaitingStep status={setup({ step: 'install' })} busy={false} onCancel={() => {}} onOpen={() => {}} />);
    for (const html of [account(), wait, confirm(setup({ repos: [repo('o/r', false)] }), ['o/r'])]) expect(html).not.toContain('\u2014');
  });
});

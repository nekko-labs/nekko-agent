import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_RUNNER_SETTINGS, PRIORITY_DESCRIPTIONS, PRIORITY_LABELS, type ConnectForm, type RunnerView } from '@nekko-agent/shared';

vi.mock('./primitives/index.js', async (original) => ({
  ...await original<typeof import('./primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

import { ConnectBody, emptyConnectForm, stepError, submitConnect } from './ConnectRunnerSheet.js';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----';
const form = (over: Partial<ConnectForm> = {}): ConnectForm => ({
  ...emptyConnectForm(), appId: '12', installationId: '34', privateKeyPem: PEM, kind: 'repo', target: 'nekko-labs/nekko-agent', ...over,
});
const view: RunnerView = {
  config: { id: 'r1', scope: { kind: 'repo', owner: 'nekko-labs', repo: 'nekko-agent' }, label: 'nekko-mac', settings: { ...DEFAULT_RUNNER_SETTINGS } },
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
    const callout = 'may be public. Keep &quot;Require approval for all outside collaborators&quot; on';
    expect(body(3, form({ allowPublic: true }))).toContain(`nekko-labs/nekko-agent ${callout}`);
    expect(html).not.toContain(callout);
  });

  it('step_1_and_2_show_their_fields', () => {
    const one = body(1, form());
    for (const s of ['App ID', 'Installation ID', 'Private key', 'How to create the app', 'https://nekkoagent.com/docs/ci-runners#create-the-github-app']) expect(one).toContain(s);
    const two = body(2, form({ kind: 'org', target: 'nekko-labs' }));
    for (const s of ['A repo', 'An org', 'Repos in the org', 'Allow public repos', 'Runner label', 'placeholder="nekko-mac"', 'runs-on: [self-hosted, macOS, ARM64, nekko-mac]']) expect(two).toContain(s);
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

import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ImagePlan, ImageView, Priority } from '@nekko-agent/shared';

vi.mock('./primitives/index.js', async (original) => ({
  ...await original<typeof import('./primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

import { FailedStep, MacSetupSheet, ModeStep, PlanStep, ProgressStep, buildRequest, setupScreen, startRunner } from './MacSetupSheet.js';

const plan = (over: Partial<ImagePlan> = {}): ImagePlan => ({ xcode: '27.2', freeGb: 369.4, needsGb: 110, ...over });
const image = (over: Partial<ImageView> = {}): ImageView => ({
  state: 'none', stage: null, doneStages: [], detail: '', bytes: null, fraction: null, error: null, log: null, info: null, canResume: false, ...over,
});
const planStep = (p: ImagePlan | null | undefined, rebuild = false, error: string | null = null) =>
  renderToStaticMarkup(<PlanStep plan={p} priority="doNotDisturb" rebuild={rebuild} error={error} busy={false} onPriority={() => {}} onBuild={() => {}} />);
const progress = (v: ImageView, onResume?: () => void) => renderToStaticMarkup(<ProgressStep image={v} error={null} busy={false} onCancel={() => {}} onResume={onResume} />);
const failed = (v: ImageView) => renderToStaticMarkup(<FailedStep image={v} error={null} busy={false} onCancel={() => {}} onRetry={() => {}} />);
const button = (html: string, name: string) => html.match(new RegExp(`<button[^>]*>${name}`))?.[0] ?? '';

describe('MacSetupSheet', () => {
  it('plan_matches_frame_5', () => {
    const html = planStep(plan());
    for (const s of ['Set up this Mac', 'macOS from Apple', 'iOS simulator from Apple', 'Xcode 27.2 from this Mac', 'Copied in', 'Space needed', '110 GB of 369 GB free', 'Do not disturb', 'Only run when I&#x27;m idle', 'Balanced', 'In the background', 'Runner first', 'For a docked Mac', 'Continuing accepts Apple&#x27;s macOS and Xcode licenses for this VM.', 'Download and set up']) expect(html).toContain(s);
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('macOS only');
  });

  it('no_xcode_offers_macos_only', () => {
    const html = planStep(plan({ xcode: null }));
    for (const s of ['macOS only', 'No Xcode on this Mac. Install Xcode for iOS jobs.', 'Continuing accepts Apple&#x27;s macOS license for this VM.']) expect(html).toContain(s);
    for (const s of ['Copied in', 'iOS simulator from Apple', 'Xcode licenses']) expect(html).not.toContain(s);
    expect(buildRequest(plan({ xcode: null }), 'balanced', 'r1', false)).toEqual({ kind: 'macosOnly', priority: 'balanced', runnerId: 'r1' });
  });

  it('a_plan_the_daemon_could_not_give_still_builds_and_lets_check_decide', () => {
    expect(planStep(null)).toContain('Xcode from this Mac');
    expect(planStep(null)).toContain('110 GB<');
    expect(button(planStep(null), 'Download and set up')).not.toContain('disabled=""');
    expect(buildRequest(null, 'doNotDisturb', 'r1', false).kind).toBe('xcode');
    expect(button(planStep(undefined), 'Download and set up')).toContain('disabled=""');
  });

  it('a_rebuild_asks_no_mode_and_names_no_runner', () => {
    const html = planStep(plan(), true);
    for (const s of ['Rebuild image', 'Download and rebuild']) expect(html).toContain(s);
    expect(html).not.toContain('type="radio"');
    expect(buildRequest(plan(), 'balanced', 'r1', true)).toEqual({ kind: 'xcode', priority: 'balanced' });
  });

  it('a_build_the_daemon_refuses_says_why_on_the_sheet', () => {
    expect(planStep(plan(), false, 'This Mac is already being set up.')).toMatch(/role="alert"[^>]*>This Mac is already being set up\./);
  });

  it('with_an_image_only_the_mode_is_asked', () => {
    const html = renderToStaticMarkup(<ModeStep priority="balanced" error={null} busy={false} onPriority={() => {}} onStart={() => {}} />);
    for (const s of ['Do not disturb', 'Balanced', 'Runner first', 'Start runner']) expect(html).toContain(s);
    for (const s of ['from Apple', 'Space needed', 'license']) expect(html).not.toContain(s);
    expect(setupScreen({ image: image({ state: 'ready' }), rebuild: false, finished: false, needsMode: false })).toBe('mode');
  });

  it('the_screen_follows_the_build', () => {
    const screen = (v: ImageView | null, rebuild = false, finished = false, needsMode = false) => setupScreen({ image: v, rebuild, finished, needsMode });
    expect(screen(null)).toBe('plan');
    expect(screen(image())).toBe('plan');
    expect(screen(image({ state: 'ready' }), true)).toBe('plan');
    expect(screen(image({ state: 'building' }))).toBe('progress');
    expect(screen(image({ state: 'waiting' }))).toBe('progress');
    expect(screen(image({ state: 'failed' }))).toBe('failed');
    expect(screen(image({ canResume: true }))).toBe('resume');
    expect(screen(image({ state: 'ready', canResume: true }))).toBe('resume');
    expect(screen(image({ state: 'ready' }), false, true)).toBe('ready');
    // A build for another runner finished, and this one still has no mode.
    expect(screen(image({ state: 'ready' }), false, true, true)).toBe('mode');
  });

  it('progress_renders_each_stage', () => {
    const html = progress(image({ state: 'building', stage: 'download', doneStages: ['check'], bytes: [12_400_000_000, 25_600_000_000] }));
    for (const s of ['Setting up this Mac', 'Check this Mac', 'Download macOS', '12.4 of 25.6 GB', 'Install macOS', 'Add Xcode and tools', 'Lock the VM down', 'Test a boot', 'You can close this.', 'Cancel setup']) expect(html).toContain(s);
    expect(html).toContain('runner-bar');
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain('Resume setup');
  });

  it('waiting_shows_its_reason', () => {
    const html = progress(image({ state: 'waiting', stage: 'install', doneStages: ['check', 'download'], detail: 'Waiting for a free VM slot' }));
    expect(html).toContain('>Waiting<');
    expect(html).toMatch(/role="status"[^>]*runner-note warn[^>]*>Waiting for a free VM slot/);
    expect(html).not.toContain('runner-bar');
  });

  it('a_stopped_build_offers_to_resume', () => {
    const html = progress(image({ stage: 'xcode', doneStages: ['check', 'download', 'install'], canResume: true }), () => {});
    for (const s of ['Setup paused', 'Paused', 'Resume setup', 'Cancel setup']) expect(html).toContain(s);
    expect(html).not.toContain('You can close this.');
  });

  it('failed_shows_the_sentence_and_try_again', () => {
    const sentence = 'This Mac has 18 GB free. Free up 42 GB, then try again.';
    const html = failed(image({ state: 'failed', stage: 'xcode', doneStages: ['check', 'download', 'install'], error: sentence, log: 'tail', canResume: true }));
    expect(html).toMatch(new RegExp(`role="alert"[^>]*>${sentence}`));
    for (const s of ['Setup stopped', 'Install macOS', 'Add Xcode and tools', 'Failed', 'Finished stages are kept.', 'Show log', 'Try again', 'Cancel setup']) expect(html).toContain(s);
    expect(html).not.toContain('Download macOS');
  });

  it('a_failed_lockdown_says_it_goes_back_further', () => {
    // Lockdown runs once per image, so the daemon restarts from the checkpoint, Xcode included.
    const html = failed(image({ state: 'failed', stage: 'lockdown', doneStages: ['check', 'download', 'install', 'xcode'], error: 'No proof.', canResume: true }));
    expect(html).toContain('Trying again goes back to the checkpoint and adds Xcode again.');
    expect(html).not.toContain('restarts this stage only');
  });

  it('check_refusing_is_a_sentence_with_a_way_out_not_a_spinner', () => {
    for (const sentence of ['Update this Mac to macOS 27 to set it up here.', 'This copy of Nekko cannot build a VM on its own. Update Nekko, or bring your own image.']) {
      const v = image({ state: 'failed', stage: 'check', error: sentence, canResume: true });
      expect(setupScreen({ image: v, rebuild: false, finished: false, needsMode: false })).toBe('failed');
      const html = failed(v);
      expect(html).toContain(renderToStaticMarkup(<>{sentence}</>));
      for (const s of ['Check this Mac', 'Try again', 'Cancel setup']) expect(html).toContain(s);
      expect(html).not.toContain('Finished stages are kept.');
      expect(html).not.toContain('Show log');
    }
  });

  it('start_sets_the_mode_then_turns_the_runner_on', async () => {
    const calls: string[] = [];
    const deps = {
      updateRunner: vi.fn(async () => { calls.push('mode'); return {} as never; }),
      setRunnerEnabled: vi.fn(async () => { calls.push('on'); return {} as never; }),
    };
    await startRunner('r1', 'runnerFirst', 'doNotDisturb', deps);
    expect(deps.updateRunner).toHaveBeenCalledWith('r1', { priority: 'runnerFirst' });
    expect(deps.setRunnerEnabled).toHaveBeenCalledWith('r1', true);
    expect(calls).toEqual(['mode', 'on']);
    await startRunner('r1', 'balanced', 'balanced', deps);
    expect(deps.updateRunner).toHaveBeenCalledTimes(1);
  });

  it('a_refused_start_rejects_with_the_daemons_sentence', async () => {
    const sentence = "This public repo doesn't hold outside contributors for approval yet.";
    const deps = { updateRunner: vi.fn(), setRunnerEnabled: vi.fn(async () => { throw new Error(sentence); }) };
    await expect(startRunner('r1', 'balanced' as Priority, 'balanced', deps)).rejects.toThrow(sentence);
  });

  it('the_sheet_opens_on_the_build_in_progress', () => {
    (globalThis as unknown as { window: unknown }).window = { nekko: {} };
    const html = renderToStaticMarkup(<MacSetupSheet runnerId="r1" view={undefined} image={image({ state: 'building', stage: 'check' })} rebuild={false} onClose={() => {}} onWorkflow={() => {}} beginReply={() => () => {}} />);
    expect(html).toContain('Setting up this Mac');
  });

  it('no_em_dash', () => {
    const v = image({ state: 'failed', stage: 'check', error: 'x' });
    for (const html of [planStep(plan()), planStep(plan({ xcode: null })), progress(image({ state: 'building', stage: 'check' })), failed(v)]) expect(html).not.toContain('\u2014');
  });
});

describe('ready burst', () => {
  const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');

  it('plays_once_for_about_a_second', () => {
    const rules = (css.match(/\.runner-burst[^{}]*\{[^{}]*animation:[^{}]*\}/g) ?? []).filter((r) => !r.includes('animation: none'));
    expect(rules).toHaveLength(4);
    for (const r of rules) {
      expect(r).toMatch(/animation: runner-\w+ 1\.1s /);
      expect(r).not.toContain('infinite');
    }
  });

  it('reduced_motion_has_no_animation', () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.runner-burst[^}]*\}/)?.[0] ?? '';
    for (const s of ['.runner-burst .ring', '.runner-burst .badge', '.runner-burst .badge path', '.runner-burst i', 'animation: none']) expect(block).toContain(s);
  });
});

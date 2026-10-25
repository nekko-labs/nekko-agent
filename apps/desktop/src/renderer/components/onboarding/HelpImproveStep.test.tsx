import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TELEMETRY_PROMISES } from '@nekko-agent/shared';
import { HelpImproveStep } from './HelpImproveStep.js';
import { UsageReportsSection } from '../UsageReports.js';
import { ONBOARDING_STEPS as STEPS, SKIPPABLE_STEP_IDS } from './onboardingMachine.js';

vi.mock('react', async (original) => {
  const React = await original<typeof import('react')>();
  // Called outside React: state keeps its first value, effects never run.
  return { ...React, useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}], useEffect: () => {} };
});
vi.mock('../../store.js', () => ({ useStore: Object.assign((f: (s: unknown) => unknown) => f({ settings: {} }), { setState: () => {} }) }));

describe('Help improve Nekko Agent', () => {
  it('is an optional onboarding step before the last one, off by default, with every promise', () => {
    const ids = STEPS.map((s) => s.id);
    expect(ids.indexOf('help')).toBe(ids.length - 2);
    expect(SKIPPABLE_STEP_IDS.has('help')).toBe(true);
    const html = renderToStaticMarkup(<HelpImproveStep />);
    expect(html).toContain('aria-checked="false"');
    for (const p of TELEMETRY_PROMISES) expect(html).toContain(p.replace(/'/g, '&#x27;'));
  });

  it('Settings shows the same promises and saves a fresh id when turned on', () => {
    const update = vi.fn();
    const tree = UsageReportsSection({ settings: {} as never, update });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Help improve Nekko Agent');
    const toggle = (tree.props.children[0].props.children[1]) as React.ReactElement<{ onChange: (v: boolean) => void }>;
    toggle.props.onChange(true);
    expect(update.mock.calls[0][0].telemetry.enabled).toBe(true);
    expect(update.mock.calls[0][0].telemetry.installId).toBeTruthy();
    toggle.props.onChange(false);
    expect(update).toHaveBeenLastCalledWith({ telemetry: { enabled: false } });
  });
});

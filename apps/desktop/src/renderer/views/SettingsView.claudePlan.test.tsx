import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { ClaudePlanFeaturesSection } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));

describe('Claude plan features', () => {
  it.each([undefined, false, 'true', 1, true])('is on only for literal true (%s)', (value) => {
    const settings = { claudePlanFeaturesApproved: value } as unknown as AppSettings;
    const html = renderToStaticMarkup(<ClaudePlanFeaturesSection settings={settings} update={() => {}} />);
    expect(html).toContain(`aria-checked="${value === true}"`);
  });
  it('always shows the warning, tied to the switch', () => {
    const html = renderToStaticMarkup(<ClaudePlanFeaturesSection settings={{} as AppSettings} update={() => {}} />);
    expect(html).toContain('Only turn this on if Anthropic has approved it for you in writing.');
    expect(html).toContain('your decision and your responsibility');
    expect(html).toContain('aria-describedby="claude-plan-features-warning"');
  });
  it('saves only the setting', () => {
    const update = vi.fn();
    const html = renderToStaticMarkup(<ClaudePlanFeaturesSection settings={{} as AppSettings} update={update} />);
    expect(html).toContain('role="switch"');
    // Find the Toggle element and flip it both ways.
    const find = (el: any): any => {
      if (!el || typeof el !== 'object') return null;
      if (el.props?.['aria-describedby'] === 'claude-plan-features-warning' && el.props.onChange) return el;
      for (const c of React.Children.toArray(el.props?.children)) {
        const hit = find(c);
        if (hit) return hit;
      }
      return null;
    };
    const toggle = find(ClaudePlanFeaturesSection({ settings: {} as AppSettings, update }));
    toggle.props.onChange(true);
    expect(update).toHaveBeenLastCalledWith({ claudePlanFeaturesApproved: true });
    toggle.props.onChange(false);
    expect(update).toHaveBeenLastCalledWith({ claudePlanFeaturesApproved: false });
  });
});

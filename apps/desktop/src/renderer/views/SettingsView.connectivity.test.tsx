import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { InternetRecoverySetting, Toggle } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));

describe('Internet restoration recovery', () => {
  it.each([undefined, false, null, 'true', 1, true])('enables recovery only for literal true (%s)', (value) => {
    const settings = { autoResumeOnInternetRestore: value } as unknown as AppSettings;
    const html = renderToStaticMarkup(<InternetRecoverySetting settings={settings} update={() => {}} />);
    expect(html).toContain(`aria-checked="${value === true}"`);
    expect(html).toContain('Off by default');
    expect(html).toContain('Additional provider usage may incur charges');
    expect(html).toContain('aria-describedby="internet-recovery-hint"');
  });
  it('writes only the explicit opt-in, without changing provider retry policy', () => {
    const update = vi.fn();
    const tree = InternetRecoverySetting({ settings: {} as AppSettings, update });
    const children = React.Children.toArray(tree.props.children) as React.ReactElement<any>[];
    const toggle = children.find((e) => e.type === Toggle)!;
    toggle.props.onChange(true);
    expect(update).toHaveBeenLastCalledWith({ autoResumeOnInternetRestore: true });
    toggle.props.onChange(false);
    expect(update).toHaveBeenLastCalledWith({ autoResumeOnInternetRestore: false });
  });
});

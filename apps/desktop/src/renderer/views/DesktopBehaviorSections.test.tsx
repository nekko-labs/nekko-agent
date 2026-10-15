import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DesktopBehaviorSection, FunSection } from './DesktopBehaviorSections.js';
import type { AppSettings } from '@nekko-agent/shared';
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));
vi.mock('../i18n.js', () => ({ useT: () => (key: string) => key === 'settings.mascot' ? 'Show Nekko mascot' : key }));
vi.mock('./SettingsView.js', () => ({ Toggle: ({ on, onChange, ...props }: any) => <button role="switch" aria-checked={on} onClick={() => onChange(!on)} {...props} /> }));
describe('Desktop and Fun settings', () => {
  it('defaults to tray and saves the shutdown choice', () => {
    const update = vi.fn(); const tree = DesktopBehaviorSection({ settings: {} as AppSettings, update });
    const html = renderToStaticMarkup(tree); expect(html).toContain('value="tray" selected');
    const select = (tree.props.children[1].props.children as React.ReactElement<any>[])[1];
    select.props.onChange({ target: { value: 'shutdown' } }); expect(update).toHaveBeenCalledWith({ desktopCloseBehavior: 'shutdown' });
  });
  it('groups independent mascot and default-on farewell switches under Fun', () => {
    const html = renderToStaticMarkup(<FunSection settings={{ mascotEnabled: false } as AppSettings} update={vi.fn()} />);
    expect(html).toContain('>Fun</h2>'); expect(html).toContain('aria-checked="true" aria-label="Tray farewell"');
    expect(html).toContain('aria-checked="false" aria-label="Show Nekko mascot"');
  });
});

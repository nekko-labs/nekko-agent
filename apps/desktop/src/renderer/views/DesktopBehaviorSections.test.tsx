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
  it('asks about low memory by default, saves a remembered choice and forgets an app', () => {
    const update = vi.fn();
    const html = renderToStaticMarkup(<DesktopBehaviorSection settings={{} as AppSettings} update={update} />);
    expect(html).toContain('value="ask" selected'); expect(html).not.toContain('Always ask these apps to close');
    const tree = DesktopBehaviorSection({ settings: { lowMemoryAction: 'release', lowMemoryCloseApps: ['PioneerGame', 'chrome'] } as AppSettings, update });
    const rows = renderToStaticMarkup(tree);
    expect(rows).toContain('value="release" selected'); expect(rows).toContain('aria-label="Stop closing PioneerGame"');
    const low = tree.props.children[2];
    const [choice, list] = (low.type as (p: any) => React.ReactElement<any>)(low.props).props.children;
    choice.props.children[1].props.onChange({ target: { value: 'ask' } }); expect(update).toHaveBeenLastCalledWith({ lowMemoryAction: undefined });
    list.props.children[2].props.children[0].props.children[1].props.onClick(); expect(update).toHaveBeenLastCalledWith({ lowMemoryCloseApps: ['chrome'] });
  });
  it('groups independent mascot and default-on farewell switches under Fun', () => {
    const html = renderToStaticMarkup(<FunSection settings={{ mascotEnabled: false } as AppSettings} update={vi.fn()} />);
    expect(html).toContain('>Fun</h2>'); expect(html).toContain('aria-checked="true" aria-label="Tray farewell"');
    expect(html).toContain('aria-checked="false" aria-label="Show Nekko mascot"');
  });
});

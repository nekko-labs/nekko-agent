import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DesktopBehaviorSection, FunSection } from './DesktopBehaviorSections.js';
import type { AppSettings } from '@nekko-agent/shared';
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));
vi.mock('../i18n.js', () => ({ useT: () => (key: string) => key === 'settings.mascot' ? 'Show Nekko mascot' : key }));
vi.mock('./SettingsView.js', () => ({ Toggle: ({ on, onChange, ...props }: any) => <button role="switch" aria-checked={on} onClick={() => onChange(!on)} {...props} /> }));
/** Every element in a tree, expanding the plain function components (rows, sections) and the controls they are handed. */
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  const out: React.ReactElement<any>[] = [];
  const walk = (n: React.ReactNode) => React.Children.forEach(n, (node) => {
    if (!React.isValidElement<any>(node)) return;
    const child = node as React.ReactElement<any>;
    out.push(child);
    if (typeof child.type === 'function') walk((child.type as (p: any) => React.ReactNode)(child.props));
    else walk(child.props.children);
  });
  walk(node);
  return out;
}
const byId = (tree: React.ReactNode, id: string) => elements(tree).find((e) => e.props.id === id)!;
describe('Desktop and Fun settings', () => {
  it('defaults to tray and saves the shutdown choice', () => {
    const update = vi.fn(); const tree = DesktopBehaviorSection({ settings: {} as AppSettings, update });
    const html = renderToStaticMarkup(tree); expect(html).toContain('value="tray" selected');
    const select = byId(tree, 'desktop-close-behavior');
    select.props.onChange({ target: { value: 'shutdown' } }); expect(update).toHaveBeenCalledWith({ desktopCloseBehavior: 'shutdown' });
  });
  it('asks about low memory by default, saves a remembered choice and forgets an app', () => {
    const update = vi.fn();
    const html = renderToStaticMarkup(<DesktopBehaviorSection settings={{} as AppSettings} update={update} />);
    expect(html).toContain('value="ask" selected'); expect(html).not.toContain('Always ask these apps to close');
    const tree = DesktopBehaviorSection({ settings: { lowMemoryAction: 'release', lowMemoryCloseApps: ['PioneerGame', 'chrome'] } as AppSettings, update });
    const rows = renderToStaticMarkup(tree);
    expect(rows).toContain('value="release" selected'); expect(rows).toContain('aria-label="Stop closing PioneerGame"');
    byId(tree, 'desktop-low-memory').props.onChange({ target: { value: 'ask' } }); expect(update).toHaveBeenLastCalledWith({ lowMemoryAction: undefined });
    elements(tree).find((e) => e.props['aria-label'] === 'Stop closing PioneerGame')!.props.onClick(); expect(update).toHaveBeenLastCalledWith({ lowMemoryCloseApps: ['chrome'] });
  });
  it('groups independent mascot and default-on farewell switches under Fun', () => {
    const html = renderToStaticMarkup(<FunSection settings={{ mascotEnabled: false } as AppSettings} update={vi.fn()} />);
    expect(html).toContain('>Fun</h2>'); expect(html).toContain('aria-checked="true" aria-label="Tray farewell"');
    expect(html).toContain('aria-checked="false" aria-label="Show Nekko mascot"');
  });
});

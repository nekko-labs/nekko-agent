import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { NotificationsSection, Toggle } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));

describe('Notifications settings', () => {
  it.each([undefined, true, false])('retains default-on semantics for %s and writes only the existing setting', (desktopNotifications) => {
    const settings = { desktopNotifications } as AppSettings;
    const update = vi.fn();
    const tree = NotificationsSection({ settings, update });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('id="notifications"');
    expect(html).toContain('aria-labelledby="notifications-heading"');
    expect(html).toContain('>Notifications</h2>');
    expect(html).toContain('Desktop notifications');
    expect(html).toContain(`aria-checked="${desktopNotifications !== false}"`);
    const elements: React.ReactElement<Record<string, any>>[] = [];
    const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
      if (!React.isValidElement<Record<string, any>>(child)) return;
      elements.push(child); walk(child.props.children);
    });
    walk(tree);
    const toggle = elements.find((e) => e.type === Toggle)!;
    toggle.props.onChange(false);
    expect(update).toHaveBeenCalledWith({ desktopNotifications: false });
    toggle.props.onChange(true);
    expect(update).toHaveBeenLastCalledWith({ desktopNotifications: true });
  });
  it('mounts Notifications as an independent settings card, not inside Agent loop', async () => {
    vi.resetModules();
    vi.doUnmock('../store.js');
    await import('../tests/browserGlobals.js');
    const { liveStore } = await import('../tests/liveStore.js');
    vi.doMock('../store.js', (original) => liveStore(original as never));
    vi.doMock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));
    const { useStore } = await import('../store.js');
    const { SettingsView } = await import('./SettingsView.js');
    const { UpdateProvider } = await import('../components/UpdateBanner.js');
    // The host's own defaults, so every section has what it reads.
    const { defaultSettings } = await import('../../../../../packages/host/dist/store.js');
    useStore.setState({ settings: defaultSettings(), settingsLoaded: true });
    const html = renderToStaticMarkup(<UpdateProvider><SettingsView /></UpdateProvider>);
    // Its own card, and the one place the setting appears.
    const cards = html.split(/(?=<section )/);
    const notifications = cards.filter((c) => c.includes('>Desktop notifications<'));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatch(/^<section id="notifications"/);
    const agentLoop = cards.find((c) => c.includes('>Agent loop</h2>'));
    expect(agentLoop).toBeDefined();
    expect(agentLoop).not.toContain('Desktop notifications');
  });
});

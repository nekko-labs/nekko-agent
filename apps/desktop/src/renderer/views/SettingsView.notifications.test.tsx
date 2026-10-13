import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { readFileSync } from 'node:fs';
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
  it('mounts Notifications as an independent settings card, not inside Agent loop', () => {
    const source = readFileSync(new URL('./SettingsView.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<ErrorBoundary label="Notifications"><NotificationsSection');
    const agentLoop = source.slice(source.indexOf('function AgentLoopSection'), source.indexOf('const HOOK_EVENTS'));
    expect(agentLoop).not.toContain('desktopNotifications');
    expect(source.match(/<span className="text-\[13px\]">Desktop notifications/g)).toHaveLength(1);
  });
});

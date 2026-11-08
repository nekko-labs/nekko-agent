import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false, windowChrome: null }));
vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));

import { useStore } from '../store.js';
import { SettingsView, SETTINGS_GROUPS } from './SettingsView.js';
import { UpdateProvider } from '../components/UpdateBanner.js';

describe('Settings Customize section', () => {
  it('replaces the separate presentation groups without moving phone pairing', () => {
    expect(SETTINGS_GROUPS.map(group => group.id)).toEqual(['general', 'phone', 'computers', 'customize', 'agents', 'safety', 'connections', 'tools', 'system']);
    expect(SETTINGS_GROUPS.find(group => group.id === 'customize')?.label).toBe('Customize');
  });

  it('groups personalization once, keeps anchors and separates operational settings', () => {
    const defaults = JSON.parse(readFileSync(new URL('../../../../../crates/nekko-settings/src/defaults.json', import.meta.url), 'utf8')).defaults;
    useStore.setState({ settings: defaults, settingsLoaded: true });
    const html = renderToStaticMarkup(<UpdateProvider><SettingsView /></UpdateProvider>);
    const groups = html.split(/(?=<div id="settings-[^"]+" data-settings-group=)/);
    const customize = groups.find(group => group.startsWith('<div id="settings-customize"'))!;
    const general = groups.find(group => group.startsWith('<div id="settings-general"'))!;
    for (const label of ['View settings', 'Appearance', 'Agents wall', 'System prompt', 'About you']) {
      expect(customize).toContain(label);
      expect(general).not.toContain(label);
    }
    for (const id of ['customization', 'settings-style', 'settings-animations', 'settings-simple']) {
      expect(customize).toContain(`id="${id}"`);
      expect(html.split(`id="${id}"`)).toHaveLength(2);
    }
    expect(general).toContain('Desktop notifications');
    for (const id of ['phone', 'safety', 'connections', 'system']) {
      expect(groups.some(group => group.startsWith(`<div id="settings-${id}"`))).toBe(true);
      expect(customize).not.toContain(`data-settings-group="${id}"`);
    }
    expect(html.indexOf('Search settings')).toBeLessThan(html.indexOf('data-settings-group="general"'));
  });
});

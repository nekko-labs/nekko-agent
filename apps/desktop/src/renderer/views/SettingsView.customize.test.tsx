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
  it('replaces the separate presentation groups with team support before General and phone pairing', () => {
    expect(SETTINGS_GROUPS.map(group => group.id)).toEqual(['profile', 'support', 'cloud', 'general', 'customize', 'agents', 'tools', 'safety', 'connections', 'phone', 'system']);
    // The id stays customize so links into it keep working; the rail says Appearance.
    expect(SETTINGS_GROUPS.find(group => group.id === 'customize')?.label).toBe('Appearance');
  });

  it('groups personalization once, keeps anchors and separates operational settings', () => {
    const defaults = JSON.parse(readFileSync(new URL('../../../../../crates/nekko-settings/src/defaults.json', import.meta.url), 'utf8')).defaults;
    useStore.setState({ settings: defaults, settingsLoaded: true });
    const html = renderToStaticMarkup(<UpdateProvider><SettingsView /></UpdateProvider>);
    const groups = html.split(/(?=<div id="settings-[^"]+" data-settings-group=)/);
    const customize = groups.find(group => group.startsWith('<div id="settings-customize"'))!;
    const general = groups.find(group => group.startsWith('<div id="settings-general"'))!;
    for (const label of ['View settings', 'Agents wall', 'Fonts and text']) {
      expect(customize).toContain(label);
      expect(general).not.toContain(label);
    }
    // Who you are lives in Profile, the first group, not Customize.
    const profile = groups.find(group => group.startsWith('<div id="settings-profile"'))!;
    for (const label of ['What Nekko calls you', 'Email for updates', 'What you mostly do', 'More about you']) {
      expect(profile).toContain(label);
      expect(customize).not.toContain(label);
    }
    expect(html.indexOf('data-settings-group="profile"')).toBeLessThan(html.indexOf('data-settings-group="support"'));
    expect(html.indexOf('data-settings-group="support"')).toBeLessThan(html.indexOf('data-settings-group="cloud"'));
    for (const id of ['settings-style', 'settings-animations', 'settings-simple']) {
      expect(customize).toContain(`id="${id}"`);
      expect(html.split(`id="${id}"`)).toHaveLength(2);
    }
    // The system prompt shapes agents, so it sits with them rather than with Appearance.
    const agents = groups.find(group => group.startsWith('<div id="settings-agents"'))!;
    expect(agents).toContain('System prompt');
    expect(customize).not.toContain('System prompt');
    expect(agents).toContain('id="customization"');
    expect(general).toContain('Desktop notifications');
    for (const id of ['profile', 'cloud', 'phone', 'safety', 'connections', 'system']) {
      expect(groups.some(group => group.startsWith(`<div id="settings-${id}"`))).toBe(true);
      expect(customize).not.toContain(`data-settings-group="${id}"`);
    }
    expect(html.indexOf('Search settings')).toBeLessThan(html.indexOf('data-settings-group="general"'));
  });

  it('shows one page at a time: Profile first, every other group mounted but hidden', () => {
    const html = renderToStaticMarkup(<UpdateProvider><SettingsView /></UpdateProvider>);
    const open = [...html.matchAll(/<div id="settings-([a-z]+)" data-settings-group=[^>]*>/g)];
    expect(open.length).toBeGreaterThan(10);
    for (const [tag, id] of open) expect(tag.includes('hidden=""')).toBe(id !== 'profile');
    // The rail labels the second and third blocks, and marks the page on screen.
    expect(html).toContain('<div class="settings-nav-label">Nekko Agent</div>');
    expect(html).toContain('<div class="settings-nav-label">Privacy and devices</div>');
    const current = html.split('aria-current="page"');
    expect(current).toHaveLength(2);
    expect(current[1].slice(0, current[1].indexOf('</button>'))).toContain('Profile');
  });
});

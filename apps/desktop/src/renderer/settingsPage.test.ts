// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { useStore } from './store.js';
import { SETTINGS_PAGE_EVENT, openSettingsPage, takePendingSettingsPage } from './settingsPage.js';

describe('openSettingsPage', () => {
  it('opens Settings, tells an open Settings which page, and leaves the page for a Settings that mounts later', () => {
    const heard: string[] = [];
    window.addEventListener(SETTINGS_PAGE_EVENT, (e) => heard.push((e as CustomEvent<string>).detail));
    openSettingsPage('storage');
    expect(useStore.getState().view).toBe('settings');
    expect(heard).toEqual(['storage']);
    expect(takePendingSettingsPage()).toBe('storage');
    expect(takePendingSettingsPage()).toBeNull();
  });
});

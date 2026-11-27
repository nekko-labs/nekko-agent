import { describe, expect, it, vi } from 'vitest';
import { activeGroup, groupSection, SETTINGS_GROUPS } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({ setView: () => {} }) }) }));

/** A scroller whose groups sit at the given viewport tops (scroller top is 0). */
function scroller(tops: number[], atBottom = false) {
  const groups = tops.map((top, i) => ({ dataset: { settingsGroup: SETTINGS_GROUPS[i].id }, getBoundingClientRect: () => ({ top }) }));
  return {
    scrollTop: atBottom ? 900 : 100, clientHeight: 100, scrollHeight: 1000,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => groups,
  } as unknown as HTMLElement;
}

describe('Settings section nav', () => {
  it('puts Profile first, then team support, then Nekko Cloud, unlabelled', () => {
    expect(SETTINGS_GROUPS.slice(0, 3).map((g) => g.id)).toEqual(['profile', 'support', 'cloud']);
    expect(SETTINGS_GROUPS.slice(0, 3).map(groupSection)).toEqual([undefined, undefined, undefined]);
  });

  it('files the rest under Nekko Agent, then Privacy and devices', () => {
    const under = (label: string) => SETTINGS_GROUPS.filter((g) => groupSection(g) === label).map((g) => g.label);
    expect(under('Nekko Agent')).toEqual(['General', 'Appearance', 'Agents', 'Tools', 'Storage']);
    expect(under('Privacy and devices')).toEqual(['Safety', 'Connections', 'Phone and computers', 'System']);
    // Each label's groups sit together, so the rail draws each label once.
    const sections = SETTINGS_GROUPS.map(groupSection).filter(Boolean);
    expect(sections.filter((s, i) => s !== sections[i - 1])).toEqual(['Nekko Agent', 'Privacy and devices']);
  });

  it('has no separate Computers group: it lives on Phone and computers', () => {
    expect(SETTINGS_GROUPS.map((g) => g.id)).not.toContain('computers');
  });

  it('while searching, picks the last group whose top has scrolled past the top', () => {
    expect(activeGroup(scroller([-400, 10, 300]))).toBe('support');
    expect(activeGroup(scroller([0, 200, 400]))).toBe('profile');
  });

  it('while searching, picks the last group once scrolled to the bottom, even if it is short', () => {
    expect(activeGroup(scroller([-800, -500, 80], true))).toBe('cloud');
  });
});

describe('openSettingsGroup', () => {
  it('leaves its target for Settings once and tells a mounted page', async () => {
    const events: string[] = [];
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => events.push(e.type) });
    const { openSettingsGroup, takeSettingsTarget, SETTINGS_TARGET_EVENT } = await import('../settingsIndex.js');
    openSettingsGroup('simple');
    expect(events).toEqual([SETTINGS_TARGET_EVENT]);
    expect(takeSettingsTarget()).toBe('simple');
    expect(takeSettingsTarget()).toBeNull();
    vi.unstubAllGlobals();
  });
});

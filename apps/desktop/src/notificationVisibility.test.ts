import { describe, expect, it } from 'vitest';
import { notificationWindowContext, visibleNotificationSession, visibleNotificationView, trustedNotificationReporter } from './notificationVisibility.js';

describe('native notification visibility', () => {
  it('rejects guest windows, subframes and missing frames', () => {
    const main = {}, child = {};
    expect(trustedNotificationReporter(true, main, main)).toBe(true);
    expect(trustedNotificationReporter(false, main, main)).toBe(false);
    expect(trustedNotificationReporter(true, child, main)).toBe(false);
    expect(trustedNotificationReporter(true, null, null)).toBe(false);
  });
  it('only trusts a chat view with a valid active id, never wall selection', () => {
    expect(visibleNotificationSession({ view: 'chat', activeSessionId: 'a' })).toBe('a');
    for (const report of [null, {}, { view: 'chat', activeSessionId: 42 }, { view: 'chat', activeSessionId: '' }, { view: 'wall', activeSessionId: 'a' }, { view: 'settings', activeSessionId: 'a' }]) {
      expect(visibleNotificationSession(report)).toBeNull();
    }
  });
  it('requires the actual window to be focused, visible, unminimized and alive', () => {
    const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true };
    expect(notificationWindowContext(window, 'a', 'chat')).toEqual({ windowHidden: false, visibleSessionId: 'a', visibleView: 'chat' });
    expect(notificationWindowContext(null, 'a').windowHidden).toBe(true);
    for (const [method, value] of [['isDestroyed', true], ['isVisible', false], ['isMinimized', true], ['isFocused', false]] as const) {
      expect(notificationWindowContext({ ...window, [method]: () => value }, 'a').windowHidden).toBe(true);
    }
  });
  it('reports the view for whole-view notices', () => {
    expect(visibleNotificationView({ view: 'workflows', activeSessionId: null })).toBe('workflows');
    for (const report of [null, {}, { view: '' }, { view: 3 }]) expect(visibleNotificationView(report)).toBeNull();
  });
});

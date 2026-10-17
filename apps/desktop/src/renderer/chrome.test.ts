import { expect, it } from 'vitest';
import { hasAppChrome, isMacChrome, syncTitleBarOverlay, windowChrome } from './chrome.js';

it('leaves native chrome unavailable when imported without a browser window', () => {
  expect(typeof window).toBe('undefined');
  expect(windowChrome).toBeUndefined();
  expect(hasAppChrome).toBe(false);
  expect(isMacChrome).toBe(false);
  expect(() => syncTitleBarOverlay()).not.toThrow();
});

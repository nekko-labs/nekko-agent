import { describe, expect, it } from 'vitest';
import { terminalKeyAction, terminalKeyLabels } from './terminalClipboard.js';

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe('terminal clipboard keys (Windows/Linux)', () => {
  it('Ctrl+C copies a selection and is the interrupt without one', () => {
    expect(terminalKeyAction(key('c', { ctrlKey: true }), true, true, false)).toBe('copy');
    expect(terminalKeyAction(key('c', { ctrlKey: true }), false, true, false)).toBeNull();
  });

  it('Ctrl+Shift+C and Ctrl+Insert always copy, never interrupt', () => {
    expect(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), false, true, false)).toBe('copy');
    expect(terminalKeyAction(key('Insert', { ctrlKey: true }), true, true, false)).toBe('copy');
  });

  it('Ctrl+V, Ctrl+Shift+V and Shift+Insert paste only when the terminal takes input', () => {
    for (const e of [key('v', { ctrlKey: true }), key('V', { ctrlKey: true, shiftKey: true }), key('Insert', { shiftKey: true })]) {
      expect(terminalKeyAction(e, false, true, false)).toBe('paste');
      expect(terminalKeyAction(e, false, false, false)).toBeNull();
    }
  });

  it('leaves other chords to the shell', () => {
    expect(terminalKeyAction(key('d', { ctrlKey: true }), true, true, false)).toBeNull();
    expect(terminalKeyAction(key('c', { ctrlKey: true, altKey: true }), true, true, false)).toBeNull();
    expect(terminalKeyAction(key('c'), true, true, false)).toBeNull();
  });
});

describe('terminal clipboard keys (macOS)', () => {
  it('keeps Ctrl+C as the interrupt even with a selection; Cmd+C/V go through the app menu', () => {
    expect(terminalKeyAction(key('c', { ctrlKey: true }), true, true, true)).toBeNull();
    expect(terminalKeyAction(key('v', { metaKey: true }), false, true, true)).toBeNull();
    expect(terminalKeyLabels(true)).toEqual({ copy: 'Cmd+C', paste: 'Cmd+V' });
  });
});

import { describe, expect, it } from 'vitest';
import { SHORTCUTS } from './shortcuts.js';

const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) => ({ key: value, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers }) as KeyboardEvent;

describe('new wall window shortcuts', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    it(`opens an agent with ${modifier}+T and a terminal with Shift+T`, () => {
      const agent = key('t', { [modifier]: true });
      const terminal = key('T', { [modifier]: true, shiftKey: true });
      expect(SHORTCUTS.newAgent.matches(agent)).toBe(true);
      expect(SHORTCUTS.newTerminal.matches(agent)).toBe(false);
      expect(SHORTCUTS.newAgent.matches(terminal)).toBe(false);
      expect(SHORTCUTS.newTerminal.matches(terminal)).toBe(true);
    });
  }
  it('does not consume plain T or Alt-modified chords', () => {
    for (const event of [key('t'), key('t', { ctrlKey: true, altKey: true }), key('T', { metaKey: true, shiftKey: true, altKey: true })]) {
      expect(SHORTCUTS.newAgent.matches(event)).toBe(false);
      expect(SHORTCUTS.newTerminal.matches(event)).toBe(false);
    }
  });
  it('preserves existing aliases', () => {
    expect(SHORTCUTS.newAgent.matches(key('n', { ctrlKey: true }))).toBe(true);
    for (const value of ['`', '~', 'j']) expect(SHORTCUTS.newTerminal.matches(key(value, { ctrlKey: true }))).toBe(true);
  });
});


describe('media creation and chat search', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    it(`requires Shift and ${modifier}, without colliding with chat search`, () => {
      for (const [shortcut, value] of [[SHORTCUTS.newMedia, 'i'], [SHORTCUTS.searchChats, 'f']] as const) {
        expect(shortcut.matches(key(value.toUpperCase(), { [modifier]: true, shiftKey: true }))).toBe(true);
        expect(shortcut.matches(key(value, { [modifier]: true }))).toBe(false);
        expect(shortcut.matches(key(value, { shiftKey: true }))).toBe(false);
        expect(shortcut.matches(key(value, { [modifier]: true, shiftKey: true, altKey: true }))).toBe(false);
      }
      expect(SHORTCUTS.findInChat.matches(key('f', { [modifier]: true, shiftKey: true }))).toBe(false);
    });
  }
});

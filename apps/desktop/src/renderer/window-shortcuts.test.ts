import { describe, expect, it, vi, afterEach } from 'vitest';
import { focusWindow, registerWindow, windowActionForKey } from './window-shortcuts.js';
const key = { key: 'E', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, repeat: false, isComposing: false, defaultPrevented: false };
afterEach(() => vi.unstubAllGlobals());
describe('focused window shortcuts', () => {
  it.each([['E', 'complete'], ['m', 'minimize'], ['Delete', 'delete']])('maps %s for Ctrl and Cmd', (value, action) => {
    expect(windowActionForKey({ ...key, key: value })).toBe(action);
    expect(windowActionForKey({ ...key, key: value, ctrlKey: false, metaKey: true })).toBe(action);
  });
  it.each([{ repeat: true }, { isComposing: true }, { defaultPrevented: true }, { altKey: true }, { shiftKey: false }, { ctrlKey: false }, { metaKey: true }, { key: 'Escape' }])('ignores unsafe or unrelated keys (%j)', (patch) => {
    expect(windowActionForKey({ ...key, ...patch })).toBeNull();
  });
  it('uses one listener and acts on one focused pane, ignoring modal keys', () => {
    let listener: (e: KeyboardEvent) => void = () => {};
    const add = vi.fn((_name, callback) => { listener = callback; });
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: vi.fn() });
    let modal = false;
    vi.stubGlobal('document', { activeElement: null, querySelector: () => modal ? {} : null });
    const element = { isConnected: true, closest: () => null, getClientRects: () => [1] } as unknown as HTMLElement;
    const a = vi.fn(), b = vi.fn();
    const removeA = registerWindow('a', element, a), removeB = registerWindow('b', element, b);
    focusWindow('b');
    const event = { ...key, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
    listener(event);
    expect(add).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledExactlyOnceWith('complete');
    modal = true;
    listener(event);
    expect(b).toHaveBeenCalledOnce();
    removeA(); removeB();
  });
  it('prefers the focused DOM pane and ignores focus outside panes or hidden panes', () => {
    let listener: (e: KeyboardEvent) => void = () => {};
    vi.stubGlobal('window', { addEventListener: (_name: string, callback: typeof listener) => { listener = callback; }, removeEventListener: vi.fn() });
    const doc = { activeElement: { closest: () => ({ dataset: { shortcutPane: 'a' } }) } as any, body: {}, querySelector: () => null };
    vi.stubGlobal('document', doc);
    let visible = true;
    const element = { isConnected: true, closest: () => null, getClientRects: () => visible ? [1] : [] } as unknown as HTMLElement;
    const a = vi.fn(), b = vi.fn();
    const removeA = registerWindow('a', element, a), removeB = registerWindow('b', element, b);
    focusWindow('b');
    const event = { ...key, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
    listener(event);
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    visible = false;
    listener(event);
    expect(a).toHaveBeenCalledOnce();
    visible = true;
    doc.activeElement = { closest: () => null };
    listener(event);
    expect(b).not.toHaveBeenCalled();
    removeA(); removeB();
  });
});

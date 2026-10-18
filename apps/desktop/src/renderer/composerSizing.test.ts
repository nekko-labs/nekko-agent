import { afterEach, describe, expect, it, vi } from 'vitest';
import './tests/browserGlobals.js';
import { cssRule, stylesheet } from './tests/css.js';
import { liveStore } from './tests/liveStore.js';
import { loadCommandCenter } from './tests/renderCommandCenter.js';
import { measureEditorContent, observeWallComposer, wallEditorHeight } from './composerSizing.js';

vi.mock('./store.js', (original) => liveStore(original as never));

const size = (overrides: Partial<Parameters<typeof wallEditorHeight>[0]> = {}) => wallEditorHeight({ content: 64, chrome: 80, extra: 0, preferred: null, viewport: 900, ...overrides });
afterEach(() => vi.unstubAllGlobals());

const styles = stylesheet('styles.css');
const board = stylesheet('components/commandWallLayouts.css');
const narrow = { media: 'max-width: 767px' };

describe('wall composer sizing', () => {
  it.each(['top', 'bottom'] as const)('docks the composer %s as a sibling of the board in the column, not over it', async (side) => {
    const page = await loadCommandCenter();
    const html = page.render({ commandWall: { composer: { side, align: 'center' } } as never });
    const column = html.slice(html.indexOf('class="wall-column"'));
    const row = column.indexOf(`class="wall-composer-row" data-dock="${side}-center"`);
    const wall = column.indexOf('data-stub="wall"');
    expect(row).toBeGreaterThan(-1);
    expect(column.match(/class="wall-composer-row"/g)).toHaveLength(1);
    expect(side === 'top' ? row < wall : row > wall).toBe(true);
    // In flow: a relative flex row that never shrinks, holding a relative composer.
    expect(cssRule(styles, '.wall-composer-row')).toMatchObject({ position: 'relative', display: 'flex', 'flex-shrink': '0' });
    expect(cssRule(styles, '.wall-composer').position).toBe('relative');
  });
  it('keeps the outer board shrinkable at narrow widths without scrolling the shell', () => {
    expect(cssRule(styles, '.wall-column')).toMatchObject({ 'min-height': '0', overflow: 'hidden' });
    expect(cssRule(styles, '.wall-column > .command-wall-layout')).toMatchObject({ flex: '1 1 0', 'min-height': '0' });
    expect(cssRule(styles, '.wall-workspace', narrow).overflow).toBe('hidden');
    expect(cssRule(styles, '.wall-workspace > .wall-agent-workspace', narrow)).toMatchObject({ flex: '1 1 0', 'min-height': '0' });
    expect(cssRule(styles, '.wall-workspace > .wall-agent-workspace')['min-height']).not.toBe('640px');
    // The board, not the shell, scrolls; the inner stage can stay tall while the viewport yields.
    expect(cssRule(board, '.command-wall-layout')).toMatchObject({ 'overflow-y': 'auto', 'overflow-x': 'hidden' });
    expect(cssRule(board, '.command-wall-stage')).toMatchObject({ position: 'relative', 'min-height': '304px' });
  });
  it('grows with rendered multiline/wrapped rows and shrinks after removal', () => {
    expect(size()).toBe(64);
    expect(size({ content: 124 })).toBe(124);
    expect(size({ content: 244 })).toBe(244);
    expect(size({ content: 64 })).toBe(64);
  });
  it('keeps saved shell height as a preference, not a ceiling', () => {
    expect(size({ preferred: 240 })).toBe(160);
    expect(size({ preferred: 240, content: 300 })).toBe(300);
    expect(size({ preferred: 240, content: 64 })).toBe(160);
    expect(size({ preferred: null })).toBe(64);
  });
  it('adds queue, attachment and skill rows without consuming preferred text space', () => {
    expect(size({ preferred: 240, chrome: 190, extra: 110 })).toBe(160);
    expect(size({ preferred: 240, chrome: 80, extra: 0 })).toBe(160);
  });
  it('caps only text to half the viewport and at most 480px including chrome', () => {
    expect(size({ content: 4000 })).toBe(370);
    expect(size({ content: 4000, viewport: 1600 })).toBe(400);
    expect(size({ content: 4000, viewport: 400 })).toBe(120);
    expect(size({ content: 4000, chrome: 500, viewport: 400 })).toBe(64);
    expect(size({ preferred: 4000 })).toBe(370);
  });
  it('releases the previous height to measure deletion and restores scroll position', () => {
    const fixture = { style: { height: '370px' }, scrollTop: 150,
      get scrollHeight(): number { expect(fixture.style.height).toBe('auto'); fixture.scrollTop = 0; return 84; },
    };
    const editor = fixture as unknown as HTMLElement;
    expect(measureEditorContent(editor)).toBe(84);
    expect(editor.style.height).toBe('370px');
    expect(editor.scrollTop).toBe(150);
  });

  it('remeasures actual input, wrapping, long unbroken text, dynamic rows and viewport changes without React renders', () => {
    let textHeight = 64;
    let chrome = 80;
    let extra = 0;
    let width = 600;
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const observers: { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      disconnect = vi.fn(); observe = vi.fn(); unobserve = vi.fn();
      constructor(public callback: () => void) { observers.push(this); }
    });
    let mutate = () => {};
    const disconnectMutation = vi.fn();
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: () => void) { mutate = callback; }
      observe = vi.fn(); disconnect = disconnectMutation;
    });
    const windowListeners = new Map<string, () => void>();
    const win = { innerHeight: 900, addEventListener: (name: string, fn: () => void) => windowListeners.set(name, fn), removeEventListener: (name: string) => windowListeners.delete(name) };
    vi.stubGlobal('window', win);
    vi.stubGlobal('getComputedStyle', () => ({ position: 'static' }));
    const editor = { style: { height: '' }, scrollTop: 0,
      get scrollHeight() { return textHeight; },
      getBoundingClientRect: () => ({ height: Number.parseFloat(editor.style.height) || 64 }),
    };
    const row = { getBoundingClientRect: () => ({ height: extra }) };
    const composer = {
      getBoundingClientRect: () => ({ height: editor.getBoundingClientRect().height + chrome }),
      querySelectorAll: (selector: string) => selector === '*' ? [] : [row],
    };
    const listeners = new Map<string, () => void>();
    const column = { clientHeight: 900 };
    const panel = {
      closest: () => column,
      querySelector: (selector: string) => selector === '.composer' ? composer : editor,
      getBoundingClientRect: () => ({ width }),
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
    } as unknown as HTMLElement;
    const flush = () => { while (frames.length) frames.shift()!(); };
    const stop = observeWallComposer(panel, 240);
    expect(editor.style.height).toBe('160px');
    // Newline input, then a narrow width wrapping words and an unbroken token.
    textHeight = 204; listeners.get('input')!(); flush();
    expect(editor.style.height).toBe('204px');
    textHeight = 304; width = 320; observers[1].callback(); flush();
    expect(editor.style.height).toBe('304px');
    textHeight = 1200; mutate(); flush();
    expect(editor.style.height).toBe('370px');
    // Queue + attachments + skill grow the shell, while reducing the text cap.
    chrome = 190; extra = 110; mutate(); flush();
    expect(editor.style.height).toBe('260px');
    textHeight = 64; mutate(); flush();
    expect(editor.style.height).toBe('160px');
    chrome = 80; extra = 0; mutate(); flush();
    expect(editor.style.height).toBe('160px');
    win.innerHeight = 400; windowListeners.get('resize')!(); flush();
    expect(editor.style.height).toBe('120px');
    // A height-only panel observer notification must not schedule another pass.
    observers[1].callback(); expect(frames).toHaveLength(0);
    stop();
    expect(listeners.size).toBe(0);
    expect(windowListeners.size).toBe(0);
    expect(disconnectMutation).toHaveBeenCalledOnce();
    observers.forEach((observer) => expect(observer.disconnect).toHaveBeenCalledOnce());
  });
});

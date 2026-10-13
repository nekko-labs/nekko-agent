import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureEditorContent, observeWallComposer, wallEditorHeight } from './composerSizing.js';

const size = (overrides: Partial<Parameters<typeof wallEditorHeight>[0]> = {}) => wallEditorHeight({ content: 64, chrome: 80, extra: 0, preferred: null, viewport: 900, ...overrides });
afterEach(() => vi.unstubAllGlobals());

describe('wall composer sizing', () => {
  it('keeps both docks in normal board flex flow rather than overlaying windows', () => {
    const view = readFileSync(new URL('./views/CommandCenterView.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(view).toContain("wall.composer.side === 'top' && composerRow");
    expect(view).toContain("wall.composer.side === 'bottom' && composerRow");
    expect(css).toMatch(/\.wall-composer-row \{[^}]*position: relative;[^}]*display: flex;[^}]*flex-shrink: 0;/);
    expect(css).toContain('.wall-composer { position: relative;');
  });
  it('keeps the outer board shrinkable at narrow widths without scrolling the shell', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.wall-column \{[^}]*min-height: 0;[^}]*overflow: hidden;/);
    expect(css).toMatch(/\.wall-column > \.command-wall-layout \{[^}]*flex: 1 1 0;[^}]*min-height: 0;/);
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*\.wall-workspace \{[^}]*overflow: hidden;[^}]*\}\s*\.wall-workspace > \.wall-agent-workspace \{[^}]*flex: 1 1 0;[^}]*min-height: 0;/);
    expect(css).not.toMatch(/\.wall-workspace > \.wall-agent-workspace \{[^}]*min-height: 640px/);
    expect(css).not.toMatch(/\.wall-column > \.command-wall-layout \{[^}]*(?:min-height: 280px|flex: 1 0 280px)/);
    const boardCss = readFileSync(new URL('./components/commandWallLayouts.css', import.meta.url), 'utf8');
    expect(boardCss).toMatch(/\.command-wall-layout \{[^}]*overflow-y: auto;[^}]*overflow-x: hidden;/);
    // The inner stage can stay tall; the outer scrolling viewport must yield.
    expect(boardCss).toContain('.command-wall-stage { position: relative; min-height: 304px; }');
  });
  it('checks outer viewport shrink and clipping rather than inner scroll content height in evidence', () => {
    const harness = readFileSync(new URL('../../../../scripts/composer-evidence-electron.cjs', import.meta.url), 'utf8');
    expect(harness).toContain('board:rect(board)');
    expect(harness).toContain('m.board.height<initial.board.height');
    expect(harness).not.toContain('m.stage.height<initial.stage.height');
    expect(harness).toContain('m.board.bottom<=m.composer.y+1');
    expect(harness).toContain("!hit.closest('.command-wall-layout')");
    expect(harness).toContain('col.scrollHeight<=col.clientHeight+1');
    expect(harness).toContain('b.scrollTop=b.scrollHeight');
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

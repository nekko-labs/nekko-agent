import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerFocus } from './ComposerFocus.js';

const hooks = vi.hoisted(() => ({
  visible: true,
  ref: { current: null as string | null },
  deps: undefined as unknown[] | undefined,
  cleanup: undefined as (() => void) | undefined,
  pending: undefined as (() => void) | undefined,
}));
vi.mock('react', () => ({
  useRef: () => hooks.ref,
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    if (hooks.deps?.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.cleanup?.();
    hooks.deps = deps;
    hooks.cleanup = effect();
  },
}));
vi.mock('../paneVisibility.js', () => ({ usePaneVisible: () => hooks.visible }));
vi.mock('../afterPaint.js', () => ({ afterPaint: (fn: () => void) => {
  hooks.pending = fn;
  return () => { hooks.pending = undefined; };
} }));

class Element {
  tagName = 'DIV';
  isContentEditable = false;
  checkVisibility = () => true;
}
const focus = vi.fn();
const setSelectionRange = vi.fn();
const editor = Object.assign(new Element(), { isContentEditable: true, value: 'restored draft', focus, setSelectionRange });
const target = { current: editor } as unknown as Parameters<typeof ComposerFocus>[0]['target'];
function render(sessionId = 'new-agent', ready = true) { ComposerFocus({ target, sessionId, ready }); }
function paint() { const fn = hooks.pending; hooks.pending = undefined; fn?.(); }

beforeEach(() => {
  hooks.visible = true;
  hooks.ref.current = null;
  hooks.deps = undefined;
  hooks.cleanup = undefined;
  hooks.pending = undefined;
  editor.isContentEditable = true;
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('document', { activeElement: new Element() });
});
afterEach(() => { hooks.cleanup?.(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('agent composer opening focus', () => {
  it('focuses after paint with the caret after the restored draft', () => {
    render();
    expect(focus).not.toHaveBeenCalled();
    paint();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(setSelectionRange).toHaveBeenCalledWith(14, 14);
  });

  it('waits for editability, including a provider enabled without a count change', () => {
    editor.isContentEditable = false;
    render('new-agent', false); paint();
    expect(focus).not.toHaveBeenCalled();
    editor.isContentEditable = true;
    render('new-agent', true); paint();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not refocus on background renders or readiness toggles after opening', () => {
    render(); paint();
    Object.assign(document, { activeElement: Object.assign(new Element(), { tagName: 'INPUT' }) });
    render(); paint();
    render('new-agent', false); paint();
    render('new-agent', true); paint();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it.each(['INPUT', 'TEXTAREA', 'DIV'])('preserves typing in another visible %s and consumes the attempt', (tagName) => {
    Object.assign(document, { activeElement: Object.assign(new Element(), { tagName, isContentEditable: tagName === 'DIV' }) });
    render(); paint();
    Object.assign(document, { activeElement: new Element() });
    render('new-agent', false); paint();
    render('new-agent', true); paint();
    expect(focus).not.toHaveBeenCalled();
  });

  it('ignores a hidden editor left focused by the previous pane', () => {
    Object.assign(document, { activeElement: Object.assign(new Element(), { isContentEditable: true, checkVisibility: () => false }) });
    render(); paint();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('focuses a newly opened session and a pane shown again, but not a hidden pane', () => {
    render(); paint();
    render('another-agent'); paint();
    hooks.visible = false;
    render('another-agent'); paint();
    expect(focus).toHaveBeenCalledTimes(2);
    hooks.visible = true;
    render('another-agent'); paint();
    expect(focus).toHaveBeenCalledTimes(3);
  });

  it('cancels pending focus when the pane hides or unmounts', () => {
    render();
    hooks.visible = false;
    render(); paint();
    expect(focus).not.toHaveBeenCalled();
    hooks.visible = true;
    render(); hooks.cleanup?.(); paint();
    expect(focus).not.toHaveBeenCalled();
  });
});

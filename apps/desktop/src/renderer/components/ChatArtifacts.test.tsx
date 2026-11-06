import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatArtifacts, HtmlRenderingCard, LivePreviewCard, htmlThumbnail, THUMB_MAX_CHARS } from './ChatArtifacts.js';
import { chatArtifacts } from '../chatArtifacts.js';
import { sessionArtifacts } from '../artifactsIndex.js';

// Hooks are scripted: each useState call takes the next value from `states`
// (then null), effects are collected to run by hand, and useContext reads the
// Sandbox flag, so the cards render as plain functions with no DOM.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], index: 0, set: vi.fn(), effects: [] as Array<() => void | (() => void)>,
  sandbox: false, el: { clientWidth: 640 } as unknown, open: vi.fn(),
}));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
  const mocked = {
    useState: () => [hooks.index < hooks.states.length ? hooks.states[hooks.index++] : (hooks.index++, null), hooks.set],
    useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
    useRef: () => ({ current: hooks.el }),
    useContext: () => hooks.sandbox,
  };
  return { ...original, ...mocked, default: { ...original, ...mocked } };
});
vi.mock('../store.js', () => ({ useStore: { getState: () => ({ openFilePane: hooks.open }) } }));
afterEach(() => { hooks.states = []; hooks.index = 0; hooks.effects = []; hooks.sandbox = false; hooks.el = { clientWidth: 640 }; vi.clearAllMocks(); vi.unstubAllGlobals(); });

const page = { path: 'C:/demo/pricing/index.html', title: 'Pricing page', filename: 'index.html' };
const render = (node: React.ReactElement, states: unknown[] = []) => { hooks.states = states; hooks.index = 0; hooks.effects = []; return renderToStaticMarkup(node); };
async function runEffects() {
  const cleanups = hooks.effects.map(effect => effect());
  await Promise.resolve(); await Promise.resolve();
  return cleanups;
}
/** Every element in a rendered tree, for finding a button to press. */
function elements(node: React.ReactNode, out: React.ReactElement<Record<string, any>>[] = []) {
  React.Children.forEach(node, child => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    out.push(child);
    elements(child.props.children, out);
  });
  return out;
}
const text = (node: React.ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : React.isValidElement<{ children?: React.ReactNode }>(node) ? text(node.props.children) : '';

describe('HTML rendering card', () => {
  it('waits for the viewport before reading, then reads the page through the file pane read', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: '<h1>Hi</h1>', binary: false, truncated: false });
    vi.stubGlobal('window', { nekko: { readFile } });
    const out = render(<HtmlRenderingCard artifact={page} sessionId="s" />);
    expect(out).toContain('data-render-card');
    expect(out).not.toContain('<iframe');
    await runEffects();
    // No IntersectionObserver here: the card counts as near at once, and only then reads.
    expect(hooks.set).toHaveBeenCalledWith(true);
    expect(readFile).not.toHaveBeenCalled();
    render(<HtmlRenderingCard artifact={page} sessionId="s" />, [true]);
    await runEffects();
    expect(readFile).toHaveBeenCalledWith('C:/demo/pricing/index.html');
    expect(hooks.set).toHaveBeenCalledWith({ path: page.path, source: '<h1>Hi</h1>' });
  });

  it('observes the card lazily and stops observing once it is near', async () => {
    const observers: Array<{ cb: (e: Array<{ isIntersecting: boolean }>) => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; options: unknown }> = [];
    vi.stubGlobal('IntersectionObserver', class { observe = vi.fn(); disconnect = vi.fn(); constructor(public cb: any, public options: unknown) { observers.push(this as any); } });
    vi.stubGlobal('window', { nekko: { readFile: vi.fn() } });
    render(<HtmlRenderingCard artifact={page} sessionId="s" />);
    await runEffects();
    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledWith(hooks.el);
    expect(hooks.set).not.toHaveBeenCalled();
    observers[0].cb([{ isIntersecting: true }]);
    expect(hooks.set).toHaveBeenCalledWith(true);
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it('draws the page scriptless, offline and inert at a desktop viewport', () => {
    vi.stubGlobal('window', { nekko: {}, nekkoPreview: { open: vi.fn() } });
    const out = render(<HtmlRenderingCard artifact={page} sessionId="s" />, [true, { path: page.path, source: '<h1>Hi</h1><script>alert(1)</script>' }]);
    expect(out).toContain('<iframe');
    expect(out).toContain('sandbox=""');
    expect(out).toMatch(/srcDoc="[^"]*Content-Security-Policy[^"]*default-src &#x27;none&#x27;/);
    expect(out).toContain('pointer-events:none');
    expect(out).toContain('width:1280px');
    expect(out).toContain('tabindex="-1"');
    expect(out).toContain('referrerPolicy="no-referrer"');
    expect(out).toContain('Pricing page');
    expect(out).toContain('index.html');
    expect(out).toContain('>Interactive</button>');
    expect(out).toContain('Open ↗');
  });

  it('scales the frame to the card width', async () => {
    vi.stubGlobal('window', { nekko: { readFile: vi.fn().mockReturnValue(new Promise(() => {})) } });
    const frame = { style: {} as Record<string, string> };
    hooks.el = { clientWidth: 640, style: frame.style };
    render(<HtmlRenderingCard artifact={page} sessionId="s" />, [true, { path: page.path, source: '<p>x</p>' }]);
    await runEffects();
    expect(frame.style.transform).toBe('scale(0.5)');
  });

  it('opens the file pane, and the isolated interactive window with the page source', async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { nekko: {}, nekkoPreview: { open } });
    hooks.states = [true, { path: page.path, source: '<p>x</p>' }]; hooks.index = 0;
    const buttons = elements(HtmlRenderingCard({ artifact: page, sessionId: 's' })).filter(e => e.type === 'button');
    buttons.find(b => text(b.props.children) === 'Open ↗')!.props.onClick();
    expect(hooks.open).toHaveBeenCalledWith(page.path, 's');
    buttons.find(b => text(b.props.children) === 'Interactive')!.props.onClick();
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith('<p>x</p>');
  });

  it('hides Interactive without the desktop bridge and disables it until the page loads', () => {
    vi.stubGlobal('window', { nekko: {} });
    expect(render(<HtmlRenderingCard artifact={page} sessionId="s" />, [true, { path: page.path, source: '<p>x</p>' }])).not.toContain('Interactive');
    vi.stubGlobal('window', { nekko: {}, nekkoPreview: { open: vi.fn() } });
    expect(render(<HtmlRenderingCard artifact={page} sessionId="s" />, [true, null])).toMatch(/disabled=""[^>]*>Interactive/);
  });

  it('keeps the card plain for large, binary, truncated or unreadable pages', async () => {
    expect(htmlThumbnail({ content: 'x'.repeat(THUMB_MAX_CHARS + 1), binary: false, truncated: false })).toEqual({ note: 'Too large to preview here' });
    expect(htmlThumbnail({ content: '<p>', binary: false, truncated: true })).toEqual({ note: 'Too large to preview here' });
    expect(htmlThumbnail({ content: '', binary: true, truncated: false })).toEqual({ note: 'Preview unavailable' });
    vi.stubGlobal('window', { nekko: { readFile: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<HtmlRenderingCard artifact={page} sessionId="s" />, [true]);
    await runEffects();
    expect(hooks.set).toHaveBeenCalledWith({ path: page.path, note: 'Could not read the page' });
    const out = render(<HtmlRenderingCard artifact={page} sessionId="s" />, [true, { path: page.path, note: 'Too large to preview here' }]);
    expect(out).not.toContain('<iframe');
    expect(out).toContain('Too large to preview here');
    expect(out).toContain('Open ↗');
  });

  it('never reads host files in Sandbox', async () => {
    const readFile = vi.fn();
    vi.stubGlobal('window', { nekko: { readFile }, nekkoPreview: { open: vi.fn() } });
    hooks.sandbox = true;
    const out = render(<HtmlRenderingCard artifact={page} sessionId="s" />, [true, { path: page.path, source: '<p>x</p>' }]);
    await runEffects();
    expect(readFile).not.toHaveBeenCalled();
    expect(out).not.toContain('<iframe');
    expect(out).toContain('unavailable in Sandbox');
    expect(out.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe('live preview card', () => {
  const [live] = chatArtifacts('[Pricing on the dev server](http://localhost:5173/pricing)');
  it('is a link the app hands to the browser, with host, port and route, and no fetch', () => {
    const out = render(<LivePreviewCard artifact={live} />);
    expect(out).toContain('href="http://localhost:5173/pricing"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer"');
    expect(out).toContain('Pricing on the dev server');
    expect(out).toContain('Live preview');
    expect(out).toContain('localhost:5173</span>/pricing');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<img');
  });
  it('stays available in Sandbox, like any web link', () => {
    hooks.sandbox = true;
    vi.stubGlobal('window', { nekko: {} });
    const out = render(<ChatArtifacts artifacts={[live]} sessionId="s" />);
    expect(out).toContain('data-live-preview');
    expect(out).not.toContain('disabled');
  });
});

describe('chat artifact list', () => {
  it('routes each kind to its card', () => {
    vi.stubGlobal('window', { nekko: {} });
    const artifacts = chatArtifacts('[Page](C:/d/index.html) [Dev](http://127.0.0.1:3000) [Notes](C:/d/notes.md) [Chart](file:///C:/d/chart.png)');
    const out = render(<ChatArtifacts artifacts={artifacts} sessionId="s" />);
    expect(out.match(/data-render-card/g)).toHaveLength(1);
    expect(out.match(/data-live-preview/g)).toHaveLength(1);
    expect(out).toContain('Open source');
    expect(out).toContain('title="Open C:/d/notes.md"');
  });
  it('keeps live previews out of the global artifacts index, and counts files once', () => {
    const session = { id: 's', title: 'Chat', messages: [
      { id: '1', role: 'assistant', createdAt: 1, content: '[Page](file:///C:/d/index.html) [Page again](C:/d/index.html) at http://localhost:5173/' },
    ] } as Parameters<typeof sessionArtifacts>[0];
    const entries = sessionArtifacts(session);
    expect(entries.map(e => [e.path, e.kind])).toEqual([['C:/d/index.html', 'web']]);
  });
});

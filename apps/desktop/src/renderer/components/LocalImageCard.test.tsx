import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalImageCard } from './LocalImageCard.js';
import { MarkdownSandbox, MarkdownSession, Markdown } from './Markdown.js';
import { ChatArtifacts } from './ChatArtifacts.js';
import { ChatImages } from '../remoteImages.js';

const viewer = { open: vi.fn(), trusted: () => false, menu: vi.fn() };

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, set: vi.fn(), state: null as unknown, open: vi.fn(), library: vi.fn() }));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
  return { ...original, default: { ...original,
    useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
    useState: () => [hooks.state, hooks.set],
  } };
});
vi.mock('../store.js', () => ({ useStore: { getState: () => ({ openFilePane: hooks.open, openInLibrary: hooks.library }) } }));
afterEach(() => { hooks.effects = []; hooks.state = null; vi.clearAllMocks(); vi.unstubAllGlobals(); });

async function runEffects() {
  const cleanups = hooks.effects.map(effect => effect());
  await Promise.resolve(); await Promise.resolve();
  return cleanups;
}

describe('local image cards', () => {
  it('automatically reads local SVG and keeps the source action', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: '<svg/>', binary: false, truncated: false });
    vi.stubGlobal('window', { nekko: { readFile } });
    const out = renderToStaticMarkup(<MarkdownSession.Provider value="s"><LocalImageCard src="/a.svg" title="Diagram" /></MarkdownSession.Provider>);
    expect(out).toContain('Open source');
    expect(out).toContain('max-w-[768px]');
    expect(readFile).not.toHaveBeenCalled();
    await runEffects();
    expect(readFile).toHaveBeenCalledWith('/a.svg');
    expect(hooks.set).toHaveBeenCalledWith({ target: '/a.svg', data: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E', error: '' });
  });
  it('offers a design image Open in Library beside Open source, and only a design', () => {
    const design = <MarkdownSession.Provider value="s"><LocalImageCard src="/p/nekko-designs/pricing-mockup.png" title="Pricing" /></MarkdownSession.Provider>;
    expect(renderToStaticMarkup(design)).toContain('Open in Library');
    expect(renderToStaticMarkup(<LocalImageCard src="/p/chart.png" title="Chart" />)).not.toContain('Open in Library');
  });
  it('renders loaded SVG exclusively in an img with bounded dimensions', () => {
    hooks.state = { target: '/a.svg', data: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E', error: '' };
    const out = renderToStaticMarkup(<LocalImageCard src="/a.svg" title="Diagram" />);
    expect(out).toContain('<img');
    expect(out).toContain('max-h-[640px]');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('in photo viewer');
  });
  it('makes only loaded previews in a chat activatable, separate from Open source', () => {
    const card = <ChatImages.Provider value={viewer}><LocalImageCard src="/a.png" title="Before: Example" /></ChatImages.Provider>;
    expect(renderToStaticMarkup(card)).not.toContain('in photo viewer');
    hooks.state = { target: '/a.png', data: 'data:image/png;base64,AAAA', error: '' };
    const loaded = renderToStaticMarkup(card);
    expect(loaded).toMatch(/<button[^>]*aria-label="Open Before: Example in photo viewer"><img[^>]*alt="Before: Example"[^>]*\/><\/button>/);
    expect(loaded).toContain('Open source');
    hooks.state = { target: '/a.png', data: '', error: 'Could not read image' };
    expect(renderToStaticMarkup(card)).not.toContain('in photo viewer');
  });
  it('never reads host files in Sandbox, including artifact cards', async () => {
    const readFile = vi.fn();
    vi.stubGlobal('window', { nekko: { readFile } });
    hooks.state = { target: '/a.svg', data: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E', error: '' };
    const out = renderToStaticMarkup(<ChatImages.Provider value={viewer}><MarkdownSandbox.Provider value><Markdown text="![Image](/a.svg)" /><ChatArtifacts artifacts={[{ path: '/b.png', title: 'Photo', filename: 'b.png' }]} sessionId="s" /></MarkdownSandbox.Provider></ChatImages.Provider>);
    await runEffects();
    expect(readFile).not.toHaveBeenCalled();
    expect(out).not.toContain('<img');
    expect(out).toContain('disabled');
    expect(out).toContain('unavailable in Sandbox');
    expect(out).not.toContain('in photo viewer');
  });
  it('never reads remote images as files, never mounts a remote src, and leaves network paths alone', async () => {
    const readFile = vi.fn();
    const fetchRemoteImage = vi.fn();
    vi.stubGlobal('window', { nekko: { readFile, fetchRemoteImage } });
    // This file's useState mock hands every hook the same value: false reads as
    // "not clicked, not near the viewport, nothing loaded", a fresh card.
    hooks.state = false;
    const out = renderToStaticMarkup(<Markdown text={'![Remote](https://example.com/a.svg) ![UNC](//server/a.png)'} />);
    await runEffects();
    expect(readFile).not.toHaveBeenCalled();
    // Outside a chat (no ChatImages provider) a remote image is click-to-load.
    expect(fetchRemoteImage).not.toHaveBeenCalled();
    expect(out).not.toContain('<img');
    expect(out).not.toContain('src="https://');
    expect(out).toContain('data-remote-image="https://example.com/a.svg"');
    expect(out).toContain('Load image');
  });
  it('reports failures and ignores a read completed after unmount', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('window', { nekko: { readFile } });
    renderToStaticMarkup(<LocalImageCard src="/a.png" title="Photo" />);
    await runEffects();
    expect(hooks.set).toHaveBeenCalledWith({ target: '/a.png', data: '', error: 'Could not read image' });
    hooks.set.mockClear(); hooks.effects = [];
    let finish!: (file: unknown) => void;
    readFile.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    renderToStaticMarkup(<LocalImageCard src="/a.png" title="Photo" />);
    const cleanup = hooks.effects[0]();
    if (cleanup) cleanup();
    finish({ imageDataUrl: 'data:image/png;base64,AAAA' });
    await Promise.resolve();
    expect(hooks.set).not.toHaveBeenCalled();
  });
});

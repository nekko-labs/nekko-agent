import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./primitives/Modal.js', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
import { LibraryArtwork, LibraryIntro, LIBRARY_INTRO_KEY, libraryIntroSeen, dismissLibraryIntro } from './LibraryIntro.js';
import { parseVoiceIntent } from '../voiceCommands.js';

afterEach(() => vi.unstubAllGlobals());
describe('Library introduction', () => {
  it('is unseen until explicitly dismissed, with persistence across reads', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
    expect(libraryIntroSeen()).toBe(false);
    renderToStaticMarkup(<LibraryIntro onClose={() => {}} />);
    expect(libraryIntroSeen()).toBe(false);
    dismissLibraryIntro();
    expect(data.get(LIBRARY_INTRO_KEY)).toBe('1');
    expect(libraryIntroSeen()).toBe(true);
  });
  it('remains usable when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    expect(libraryIntroSeen()).toBe(false);
    expect(() => dismissLibraryIntro()).not.toThrow();
  });
  it('explains the real file lifecycle, ends with something to try, and can close', () => {
    const html = renderToStaticMarkup(<LibraryIntro onClose={() => {}} />);
    expect(html).toContain('Welcome to your Library');
    expect(html.match(/<li>/g)).toHaveLength(3);
    for (const copy of ['original folders', 'Nothing is published automatically', 'Try this in a chat', 'Explore Library', 'Close Library guide', 'reopen this']) expect(html).toContain(copy);
    expect(html).not.toContain('autoPlay');
  });
  it('uses original static, theme-aware artwork without external assets', () => {
    const html = renderToStaticMarkup(<LibraryArtwork />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('var(--accent)');
    expect(html).not.toMatch(/https?:|<script|<image|<animate/);
  });
  it('opens Library through voice while keeping the existing route and old alias', () => {
    for (const text of ['Nekko, open Library', 'Nekko, go to the Library page', 'Nekko, open Artifacts']) expect(parseVoiceIntent(text)).toEqual({ kind: 'navigate', view: 'artifacts' });
  });
});

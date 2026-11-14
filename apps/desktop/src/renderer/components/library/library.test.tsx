import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIBRARY_COLLAPSED_KEY, LIBRARY_LAYOUT_KEY, loadCollapsedKinds, loadLibraryLayout, orderForProfile, saveCollapsedKinds, saveLibraryLayout,
} from './libraryPrefs.js';
import { ArtifactPreview, KIND_COLOR, variantOf } from './ArtifactPreview.js';
import { LibraryFileIcon } from './LibraryFileIcon.js';
import { SlideToggle } from './SlideToggle.js';
import { ARTIFACT_KINDS } from '../../artifactsIndex.js';

const memoryStorage = () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
  return data;
};
const blockedStorage = () => vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
const groups = ARTIFACT_KINDS.map((kind) => ({ kind, items: [] }));

afterEach(() => vi.unstubAllGlobals());

describe('Library layout and folded groups', () => {
  it('opens on large icons, then remembers the chosen layout', () => {
    const data = memoryStorage();
    expect(loadLibraryLayout()).toBe('large');
    saveLibraryLayout('list');
    expect(data.get(LIBRARY_LAYOUT_KEY)).toBe('list');
    expect(loadLibraryLayout()).toBe('list');
    data.set(LIBRARY_LAYOUT_KEY, 'mosaic');
    expect(loadLibraryLayout()).toBe('large');
  });
  it('starts every group expanded and remembers the ones folded away', () => {
    const data = memoryStorage();
    expect(loadCollapsedKinds().size).toBe(0);
    saveCollapsedKinds(new Set(['doc', 'data']));
    expect(JSON.parse(data.get(LIBRARY_COLLAPSED_KEY)!)).toEqual(['doc', 'data']);
    expect([...loadCollapsedKinds()]).toEqual(['doc', 'data']);
    data.set(LIBRARY_COLLAPSED_KEY, '{not json');
    expect(loadCollapsedKinds().size).toBe(0);
  });
  it('still works for the visit when storage is blocked', () => {
    blockedStorage();
    expect(loadLibraryLayout()).toBe('large');
    expect(loadCollapsedKinds().size).toBe(0);
    expect(() => saveLibraryLayout('cards')).not.toThrow();
    expect(() => saveCollapsedKinds(new Set(['web']))).not.toThrow();
  });
});

describe('Library group order: Designs, then the setup answer', () => {
  const ids = (list: readonly { kind: { id: string } }[]) => list.map((g) => g.kind.id);
  const usual = ARTIFACT_KINDS.map((k) => k.id).filter((id) => id !== 'design');
  it.each([
    ['developer', 'web'], ['writer', 'doc'], ['student', 'doc'], ['business', 'office'],
  ] as const)('%s sees Designs, then %s', (profile, kind) => {
    const ordered = orderForProfile(groups, profile);
    expect(ids(ordered).slice(0, 2)).toEqual(['design', kind]);
    expect(ordered).toHaveLength(groups.length);
  });
  it('puts Designs first for a designer, and keeps the rest in the usual order', () => {
    expect(ids(orderForProfile(groups, 'designer'))).toEqual(['design', ...usual]);
  });
  it('puts Designs first for Just exploring and no answer, then the usual order', () => {
    expect(ids(orderForProfile(groups, 'exploring'))).toEqual(['design', ...usual]);
    expect(ids(orderForProfile(groups, undefined))).toEqual(['design', ...usual]);
  });
  it('skips a kind with no files', () => {
    const noDesigns = groups.filter((g) => g.kind.id !== 'design');
    expect(ids(orderForProfile(noDesigns, 'developer'))).toEqual(['web', ...usual.filter((id) => id !== 'web')]);
    const noPages = groups.filter((g) => g.kind.id !== 'web');
    expect(ids(orderForProfile(noPages, 'developer'))).toEqual(['design', ...usual.filter((id) => id !== 'web')]);
  });
});

describe('Library previews', () => {
  it('draws a stable picture per file from its kind and extension, without reading it', () => {
    expect(variantOf('/r/a.md', 3)).toBe(variantOf('/r/a.md', 3));
    const html = renderToStaticMarkup(<ArtifactPreview kind="web" path="/r/page.html" ext="html" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-preview-kind="web"');
    expect(html).toContain('>HTML<');
    expect(html).toContain(KIND_COLOR.web);
    expect(html).not.toMatch(/https?:|<image|<script|<foreignObject/);
  });
  it('leaves the extension off a row icon, where it would be unreadable', () => {
    expect(renderToStaticMarkup(<ArtifactPreview kind="doc" path="/r/a.md" ext="md" icon />)).not.toContain('>MD<');
  });
  it('has a drawing for every kind', () => {
    for (const { id } of ARTIFACT_KINDS) expect(renderToStaticMarkup(<ArtifactPreview kind={id} path={`/x.${id}`} ext="x" />)).toContain(`data-preview-kind="${id}"`);
  });
});

describe('compact Library row icons', () => {
  it('uses a small shared symbol per kind without reading files or rendering tile art', () => {
    for (const { id } of ARTIFACT_KINDS) {
      const html = renderToStaticMarkup(<LibraryFileIcon kind={id} />);
      expect(html).toContain(`data-library-file-icon="${id}"`);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).not.toMatch(/<image|<iframe|<text|data-preview-kind/);
    }
  });
});

describe('SlideToggle', () => {
  const options = [{ id: 'list', label: 'List' }, { id: 'large', label: 'Large icons' }] as const;
  it('is a radiogroup with one tab stop on the picked segment', () => {
    const html = renderToStaticMarkup(<SlideToggle label="Layout" options={options} value="large" onChange={() => {}} iconOnly />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Layout"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Large icons"[^>]*tabindex="0"/);
    expect(html).toMatch(/aria-checked="false"[^>]*aria-label="List"[^>]*tabindex="-1"/);
  });
  it('names its segments for a view transition only when asked', () => {
    expect(renderToStaticMarkup(<SlideToggle label="Show" options={options} value="list" onChange={() => {}} />)).not.toContain('view-transition-name');
    expect(renderToStaticMarkup(<SlideToggle label="Show" options={options} value="list" onChange={() => {}} transitionName="library-show" />)).toContain('view-transition-name:library-show-0');
  });
});

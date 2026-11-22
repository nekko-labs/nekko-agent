import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./primitives/Modal.js', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
import { CONNECTORS_GUIDE, DESIGN_GUIDE, MEMORY_GUIDE, PageIntro, SKILLS_GUIDE, dismissIntro, introSeen } from './PageIntro.js';

const GUIDES = [SKILLS_GUIDE, DESIGN_GUIDE, CONNECTORS_GUIDE, MEMORY_GUIDE];

afterEach(() => vi.unstubAllGlobals());
describe('page introduction guides', () => {
  it('remembers each page on its own, and stays closable without storage', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    for (const g of GUIDES) expect(introSeen(g.page)).toBe(false);
    dismissIntro('skills');
    expect(data.get('nekko.skillsIntroSeen')).toBe('1');
    expect(introSeen('skills')).toBe(true);
    expect(introSeen('memory')).toBe(false);
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    expect(introSeen('design')).toBe(false);
    expect(() => dismissIntro('design')).not.toThrow();
  });

  it.each(GUIDES)('$name: a few plain steps, one thing to try, and a way back', (guide) => {
    const html = renderToStaticMarkup(<PageIntro guide={guide} onClose={() => {}} />);
    expect(html).toContain(`Welcome to ${guide.name}`);
    expect(html).toContain(`data-${guide.page}-intro`);
    expect(html.match(/<li>/g)).toHaveLength(3);
    for (const copy of ['Try this', guide.cta, `Close ${guide.name} guide`, `reopen this from ${guide.name} guide`]) expect(html).toContain(copy);
    // No developer terms (#1273-#1276).
    const words = [guide.lead, guide.tryThis, ...guide.steps.flat()].join(' ');
    expect(words).not.toMatch(/\b(MCP|API|token|context|repo|CLI|prompt|workflow|HTML|model)s?\b/i);
  });
});

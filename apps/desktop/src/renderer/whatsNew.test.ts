import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isGfIconName } from './gentleface-icons.js';
import { highlightsFor, lineOf, prUrl, splitHighlights, TOP_HIGHLIGHTS, whatsNewUrl, type Highlight } from './whatsNew.js';

const h = (pr: number, over: Partial<Highlight> = {}): Highlight => ({ title: `Change ${pr}`, detail: 'One line.', pr, ...over });

// A release line as docs/hub/whats-new.json writes it: the sheet reads only `highlights`.
const entry = (highlights: unknown) => ({ date: '2026-11-19', tag: 'v0.10.1000', intro: 'Intro.', contributors: ['someone'], highlights });

// The file the website page is built from (scripts/build-docs.mjs `loadWhatsNew`).
const shared = JSON.parse(readFileSync(new URL('../../../../docs/hub/whats-new.json', import.meta.url), 'utf8')) as Record<string, { highlights: unknown[] }>;

describe('lineOf', () => {
  it('is MAJOR.MINOR of the running version', () => {
    expect(lineOf('0.10.1004')).toBe('0.10');
    expect(lineOf('1.10.1000')).toBe('1.10');
    expect(lineOf('0.9.8')).toBe('0.9');
  });

  it('is null for something that is not a version', () => {
    expect(lineOf('')).toBeNull();
    expect(lineOf('dev')).toBeNull();
    expect(lineOf('10')).toBeNull();
  });
});

describe('highlightsFor', () => {
  const data = { $comment: 'Written by hand.', '0.10': entry([h(1), h(2)]), '0.11': entry([h(3)]) };

  it('finds the line a build belongs to, whatever its build number', () => {
    expect(highlightsFor('0.10.1000', data).map((x) => x.pr)).toEqual([1, 2]);
    expect(highlightsFor('0.10.1004', data).map((x) => x.pr)).toEqual([1, 2]);
    expect(highlightsFor('0.11.1000', data).map((x) => x.pr)).toEqual([3]);
  });

  it('has nothing for a line the file does not know, or a bad version', () => {
    expect(highlightsFor('0.12.1000', data)).toEqual([]);
    expect(highlightsFor('dev', data)).toEqual([]);
  });

  it('never reads an inherited key or the comment as a line', () => {
    expect(highlightsFor('constructor.name.1', data)).toEqual([]);
    expect(highlightsFor('$comment.1', data)).toEqual([]);
  });

  it('ignores fields it does not use, including ones added later', () => {
    const extra = { '0.10': { ...entry([{ ...h(1, { icon: 'bolt' }), authors: ['a'], major: true, kind: 'feature' }]), major: true } };
    expect(highlightsFor('0.10.1000', extra)).toEqual([h(1, { icon: 'bolt' })]);
  });

  it('has nothing for a line in the old shape, a bare list', () => {
    expect(highlightsFor('0.10.1000', { '0.10': [h(1)] })).toEqual([]);
  });

  it('drops entries a workflow wrote badly instead of failing', () => {
    const messy = { '0.10': entry([h(1), { title: 'No detail', pr: 2 }, { title: '', detail: 'x', pr: 3 }, h(0), h(1.5), null, 'text', h(4)]) };
    expect(highlightsFor('0.10.1000', messy).map((x) => x.pr)).toEqual([1, 4]);
    expect(highlightsFor('0.10.1000', { '0.10': entry('nope') })).toEqual([]);
    expect(highlightsFor('0.10.1000', { '0.10': 'nope' })).toEqual([]);
    expect(highlightsFor('0.10.1000', { '0.10': null })).toEqual([]);
    expect(highlightsFor('0.10.1000', null)).toEqual([]);
  });

  it('keeps an icon name only when it is a string', () => {
    const [a, b] = highlightsFor('0.10.1000', { '0.10': entry([h(1, { icon: 'bolt' }), { ...h(2), icon: 7 }]) });
    expect(a.icon).toBe('bolt');
    expect(b.icon).toBeUndefined();
  });
});

describe('splitHighlights', () => {
  it('shows three and keeps the rest for "Show more"', () => {
    const { top, rest } = splitHighlights([h(1), h(2), h(3), h(4), h(5)]);
    expect(top.map((x) => x.pr)).toEqual([1, 2, 3]);
    expect(rest.map((x) => x.pr)).toEqual([4, 5]);
    expect(TOP_HIGHLIGHTS).toBe(3);
  });

  it('has no rest at three or fewer', () => {
    expect(splitHighlights([h(1), h(2), h(3)]).rest).toEqual([]);
    expect(splitHighlights([])).toEqual({ top: [], rest: [] });
  });
});

describe('links', () => {
  it("opens the running line's section of the website's What's new page", () => {
    expect(whatsNewUrl('0.10.1004')).toBe('https://nekkoagent.com/whatsnew#0.10');
    expect(whatsNewUrl('1.10.1000')).toBe('https://nekkoagent.com/whatsnew#1.10');
    expect(whatsNewUrl('0.9.8')).toBe('https://nekkoagent.com/whatsnew#0.9');
  });

  it('gives a development build its line too', () => {
    expect(whatsNewUrl('0.10.1004-dev.12+gabc1234')).toBe('https://nekkoagent.com/whatsnew#0.10');
  });

  it('opens the top of the page for something that is not a version', () => {
    expect(whatsNewUrl('')).toBe('https://nekkoagent.com/whatsnew');
    expect(whatsNewUrl('dev')).toBe('https://nekkoagent.com/whatsnew');
  });

  it('links a highlight to its pull request', () => {
    expect(prUrl(2732)).toBe('https://github.com/nekko-labs/nekko-agent/pull/2732');
  });
});

describe('the bundled file', () => {
  it("is the website's highlights file, read in full", () => {
    const lines = Object.keys(shared).filter((key) => !key.startsWith('$'));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\d+\.\d+$/);
      expect(highlightsFor(`${line}.1000`), line).toHaveLength(shared[line]!.highlights.length);
      expect(highlightsFor(`${line}.1000`), line).toEqual(highlightsFor(`${line}.1000`, shared));
    }
  });

  it('names only bundled icons where it names one', () => {
    for (const line of Object.keys(shared).filter((key) => !key.startsWith('$'))) {
      for (const item of highlightsFor(`${line}.1000`)) {
        if (item.icon !== undefined) expect(isGfIconName(item.icon), `${line} #${item.pr} icon`).toBe(true);
      }
    }
  });
});

describe('isGfIconName', () => {
  it('knows a bundled icon from an unknown or inherited name', () => {
    expect(isGfIconName('bolt')).toBe(true);
    expect(isGfIconName('search')).toBe(true);
    expect(isGfIconName('magnifier')).toBe(false);
    expect(isGfIconName('toString')).toBe(false);
  });
});

describe("the spec's topic table", () => {
  it('names only bundled icons', () => {
    const spec = readFileSync(new URL('../../../../spec/desktop/whats-new-sheet.md', import.meta.url), 'utf8');
    const icons = [...spec.matchAll(/^\s*\| [^|`]+ \| `([a-z-]+)` \|$/gm)].map(match => match[1]!);

    expect(icons.length).toBeGreaterThan(10);
    expect(icons).toContain('search');
    for (const name of icons) expect(isGfIconName(name), name).toBe(true);
  });
});

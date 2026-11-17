import { describe, expect, it } from 'vitest';
import { RELEASE_NOTES_URL } from '@nekko-agent/shared';
import bundled from './whatsNew.json';
import { isGfIconName } from './gentleface-icons.js';
import { highlightsFor, lineOf, prUrl, releaseUrl, splitHighlights, TOP_HIGHLIGHTS, type Highlight } from './whatsNew.js';

const h = (pr: number, over: Partial<Highlight> = {}): Highlight => ({ title: `Change ${pr}`, detail: 'One line.', pr, ...over });

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
  const data = { '0.10': [h(1), h(2)], '0.11': [h(3)] };

  it('finds the line a build belongs to, whatever its build number', () => {
    expect(highlightsFor('0.10.1000', data).map((x) => x.pr)).toEqual([1, 2]);
    expect(highlightsFor('0.10.1004', data).map((x) => x.pr)).toEqual([1, 2]);
    expect(highlightsFor('0.11.1000', data).map((x) => x.pr)).toEqual([3]);
  });

  it('has nothing for a line the file does not know, or a bad version', () => {
    expect(highlightsFor('0.12.1000', data)).toEqual([]);
    expect(highlightsFor('dev', data)).toEqual([]);
  });

  it('never reads an inherited key as a line', () => {
    expect(highlightsFor('constructor.name.1', data)).toEqual([]);
  });

  it('drops entries a workflow wrote badly instead of failing', () => {
    const messy = { '0.10': [h(1), { title: 'No detail', pr: 2 }, { title: '', detail: 'x', pr: 3 }, h(0), h(1.5), null, 'text', h(4)] };
    expect(highlightsFor('0.10.1000', messy).map((x) => x.pr)).toEqual([1, 4]);
    expect(highlightsFor('0.10.1000', { '0.10': 'nope' })).toEqual([]);
    expect(highlightsFor('0.10.1000', null)).toEqual([]);
  });

  it('keeps an icon name only when it is a string', () => {
    const [a, b] = highlightsFor('0.10.1000', { '0.10': [h(1, { icon: 'bolt' }), { ...h(2), icon: 7 }] });
    expect(a.icon).toBe('bolt');
    expect(b.icon).toBeUndefined();
  });
});

describe('splitHighlights', () => {
  it('shows three and keeps the rest for "Show N more"', () => {
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
  it("opens the running version's own release page", () => {
    expect(releaseUrl('0.10.1004')).toBe('https://github.com/nekko-labs/nekko-agent/releases/tag/v0.10.1004');
    expect(releaseUrl('1.10.1000')).toBe('https://github.com/nekko-labs/nekko-agent/releases/tag/v1.10.1000');
  });

  it('falls back to the latest release for a version outside the fixed-width scheme', () => {
    expect(releaseUrl('0.9.8')).toBe(RELEASE_NOTES_URL);
    expect(releaseUrl('0.10.1004-dev')).toBe(RELEASE_NOTES_URL);
    expect(releaseUrl('')).toBe(RELEASE_NOTES_URL);
  });

  it('links a highlight to its pull request', () => {
    expect(prUrl(2732)).toBe('https://github.com/nekko-labs/nekko-agent/pull/2732');
  });
});

describe('the bundled file', () => {
  it('holds only well-formed highlights, each with a bundled icon', () => {
    for (const [line, list] of Object.entries(bundled as Record<string, unknown[]>)) {
      expect(line).toMatch(/^\d+\.\d+$/);
      const read = highlightsFor(`${line}.1000`);
      expect(read).toHaveLength(list.length);
      for (const item of read) expect(isGfIconName(item.icon ?? ''), `${line} #${item.pr} icon`).toBe(true);
    }
  });
});

describe('isGfIconName', () => {
  it('knows a bundled icon from an unknown or inherited name', () => {
    expect(isGfIconName('bolt')).toBe(true);
    expect(isGfIconName('sparkles')).toBe(false);
    expect(isGfIconName('toString')).toBe(false);
  });
});

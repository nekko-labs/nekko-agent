import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guard every preformatted expanded surface, including conditional branches.
// The hidden Electron integration additionally checks computed layout, original
// text and vertical scroll interaction at desktop and narrow widths.
describe('expanded tool detail containment', () => {
  for (const [name, count] of [['ActivityGroup', 2], ['ToolCard', 1], ['WatchRow', 3]] as const) {
    it(`${name} wraps unbroken text without discarding indentation or height caps`, () => {
      const source = readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8');
      const wells = [...source.matchAll(/<pre className=(?:"([^"]+)"|\{`([^`]+)`\})/g)];
      expect(wells).toHaveLength(count);
      for (const well of wells) {
        const classes = well[1] || well[2];
        expect(classes).toContain('whitespace-pre-wrap');
        expect(classes).toContain('[overflow-wrap:anywhere]');
        expect(classes).toMatch(/max-h-(40|60|72)/);
        expect(classes).toContain('overflow-auto');
        expect(classes).not.toContain('whitespace-nowrap');
        expect(classes).not.toContain('break-all');
      }
    });
  }
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('compact board and navigation spacing', () => {
  it('centres a subtle 60% band behind icons with 3px more separation', () => {
    const css = read('./styles.css');
    expect(css).toContain('inset: 20% 0;');
    expect(css).toContain('var(--accent) 4%, var(--paper)');
    expect(css).toContain('var(--accent) 7%, var(--paper)');
    expect(read('./App.tsx')).toContain('flex flex-col gap-[7px] overflow-hidden');
  });

  it('keeps 1px around the board and beside the agent list without shrinking grips', () => {
    const css = read('./components/commandWallLayouts.css');
    expect(css).toContain('padding: 14px 1px;');
    expect(css).toContain("[data-tabs='left'] { flex-direction: row; gap: 1px; }");
    const styles = read('./styles.css');
    expect(styles).toContain('padding-inline: 15px calc(15px + var(--wall-gutter));');
    expect(styles).toContain('width: 14px; z-index: 2; cursor: col-resize;');
  });
});

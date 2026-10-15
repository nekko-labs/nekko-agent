import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('compact board and navigation spacing', () => {
  it('centres a subtle band on the destination group with equal end caps', () => {
    const css = read('./styles.css');
    expect(css).toContain('& .rail-group::before');
    expect(css).toContain('inset: -48px -6px;');
    expect(css).not.toContain('inset: 20% 0;');
    expect(read('./App.tsx')).toContain('className="rail-group"');
    expect(css).toContain('var(--accent) 4%, var(--paper)');
    expect(css).toContain('var(--accent) 7%, var(--paper)');
    expect(read('./App.tsx')).toContain('flex-col gap-[7px] overflow-y-auto overflow-x-hidden');
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

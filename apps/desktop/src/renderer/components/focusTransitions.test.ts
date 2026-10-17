import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const wall = readFileSync(new URL('./CommandWall.tsx', import.meta.url), 'utf8');
const pane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
const dock = readFileSync(new URL('./MonitorsDock.tsx', import.meta.url), 'utf8');

describe('Focused mode transitions', () => {
  it('fades a newly added hero in, only in Focus and never for panes present at mount', () => {
    expect(wall).toContain("if (state.layout.mode !== 'focus') enteringPane.current = null;");
    expect(wall).toContain('if (seenPanes.current) for (const id of ids)');
    expect(wall).toContain("data-wall-entering={(entering && state.layout.mode === 'focus' && hero) || undefined}");
    expect(css).toMatch(/\[data-wall-hero\]\[data-wall-entering\] > \.panel \{ animation: focus-new-agent-in/);
  });
  it('expands the composer into the full chat once, after the first send', () => {
    expect(pane).toContain('if (wasCleanStart.current && !cleanStart && cleanStartWanted && !welcomeState.welcome) setExpanding(true);');
    expect(pane).toContain('data-chat-expanding={expanding || undefined}');
    expect(css).toMatch(/\[data-chat-expanding\] > section \{ animation: composer-expand-in/);
  });
  it('turns both animations off for reduced motion', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\n  \.command-wall-layout\[data-wall-layout='focus'\] \.command-wall-window\[data-wall-entering\] > \.panel, \[data-chat-expanding\] > section \{ animation: none; \}/);
  });
  it('keeps the Focused selection ring calm: a muted mix, no glow', () => {
    expect(css).toContain(".command-wall-layout[data-wall-layout='focus'] .command-wall-window[data-wall-selected] > .panel { --panel-ring-color: color-mix(in srgb, var(--accent) 28%, var(--line)) !important; box-shadow: none; }");
  });
});

describe('Monitors dock header', () => {
  it('reads Monitors, not Panels', () => {
    expect(dock).toContain('<strong>Monitors</strong>');
    expect(dock).not.toContain('<strong>Panels</strong>');
  });
});

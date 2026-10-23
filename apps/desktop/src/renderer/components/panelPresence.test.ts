import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dock = readFileSync('src/renderer/components/MonitorsDock.tsx', 'utf8');
const agents = readFileSync('src/renderer/views/CommandCenterView.tsx', 'utf8');

describe('panel presence transition contract', () => {
  it('removes only the Focused pane frame and title strip, not terminal content', () => {
    const css = readFileSync('src/renderer/styles.css', 'utf8');
    expect(css).toContain(".command-wall-layout[data-wall-layout='focus'] .command-wall-window > .panel {");
    expect(css).toContain('--panel-ring-width: 0px !important');
    expect(css).toContain(".command-wall-layout[data-wall-layout='focus'] .command-wall-window > .panel::after { display: none; }");
    expect(css).toContain(".command-wall-layout[data-wall-layout='focus'] [data-pane-title-strip] { display: none; }");
    expect(readFileSync('src/renderer/components/PaneFrame.tsx', 'utf8')).toContain('data-pane-title-strip');
  });
  it('cancels pending removal on reversal and unmount', () => {
    expect(dock).toContain('return show || retained');
    expect(dock).toContain('clearTimeout(timer)');
    expect(dock).toContain("motion.removeEventListener?.('change', changed)");
    expect(dock).toContain('if (show) { setRetained(true); return; }');
  });

  it('skips exit delay for reduced motion, including preference changes', () => {
    expect(dock).toContain('if (motion.matches) { setRetained(false); return; }');
    expect(dock).toContain('if (motion.matches) finish()');
  });

  it('makes outgoing panels inert and hidden from assistive technology', () => {
    expect(dock).toContain('inert={!dock.show} aria-hidden={!dock.show}');
    expect(agents).toContain('inert={!panel.show} aria-hidden={!panel.show}');
  });

  it.each(['commandWallLayouts.css', 'monitorsDock.css'])('keeps %s transitions short and disables reduced motion', (file) => {
    const css = readFileSync(`src/renderer/components/${file}`, 'utf8');
    expect(css).toContain('transition: opacity 140ms ease-out, transform 140ms ease-out');
    expect(css).toContain('@starting-style');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.(?:wall-agents-presence|monitors-dock) \{ transition: none; transform: none; \} \}/);
  });
});

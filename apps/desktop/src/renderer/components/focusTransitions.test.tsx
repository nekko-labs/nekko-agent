import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { cssRule, cssValue, hasKeyframes, stylesheet } from '../tests/css.js';
import { liveStore } from '../tests/liveStore.js';
import { chatSession, renderChatPane, withProvider } from '../tests/renderChatPane.js';
import { loadWall, summary, windowTag } from '../tests/renderWall.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('./ResourceMonitor.js', () => ({ MonitorComputerSwitch: () => null, useMonitors: () => ({}), useResourceSample: () => ({ system: null, gpu: null }) }));

const styles = stylesheet('styles.css');
const FOCUS_WINDOW = ".command-wall-layout[data-wall-layout='focus'] .command-wall-window";
const two = { root: { id: 'r', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'a', kind: 'chat', refId: 'a' }, { id: 'b', kind: 'chat', refId: 'b' }] } as never };

describe('Focused mode transitions', () => {
  it('never marks windows already on the wall at mount as entering, in any layout', async () => {
    const wall = await loadWall();
    for (const mode of ['focus', 'grid'] as const) {
      const html = wall.render({ ...two, layout: { mode, cols: 2, rows: 1 }, hero: 'a' }, { sessions: [summary('a'), summary('b')] });
      expect(html, mode).not.toContain('data-wall-entering');
    }
  });

  it('fades a newly added Focus hero in, and expands the composer into the chat once', () => {
    expect(cssRule(styles, `${FOCUS_WINDOW}[data-wall-hero][data-wall-entering] > .panel`).animation).toMatch(/^focus-new-agent-in /);
    expect(hasKeyframes(styles, 'focus-new-agent-in')).toBe(true);
    // The hero it replaces is drawn while parked, collapses onto the composer's box and dissolves.
    expect(cssRule(styles, '.command-wall-window[data-wall-parked][data-wall-leaving]')['content-visibility']).toBe('visible');
    expect(cssRule(styles, '.command-wall-window[data-wall-leaving] > .panel').animation).toMatch(/^focus-collapse-into-composer /);
    expect(hasKeyframes(styles, 'focus-collapse-into-composer')).toBe(true);
    expect(cssRule(styles, '[data-chat-expanding] > section').animation).toMatch(/^composer-expand-in /);
    expect(hasKeyframes(styles, 'composer-expand-in')).toBe(true);
    // A chat that is not leaving a clean start is not expanding.
    withProvider();
    expect(renderChatPane(chatSession(), { commandCenter: true, cleanStart: true })).not.toContain('data-chat-expanding');
  });

  // Source pins, pending the focus-transitions e2e journey (Unfinished work): which pane is
  // entering, and the expansion after the first send, are set by layout effects across
  // renders, which a server render never runs.
  it('marks only a hero added after mount, and expands after the first send (source pin)', () => {
    const wall = readFileSync(new URL('./CommandWall.tsx', import.meta.url), 'utf8');
    expect(wall).toMatch(/if \(state\.layout\.mode !== 'focus'\) enteringPane\.current = leavingPane\.current = null;/);
    expect(wall).toMatch(/if \(seenPanes\.current\) for \(const id of ids\)/);
    expect(wall).toMatch(/data-wall-entering=\{\(entering && state\.layout\.mode === 'focus' && hero\) \|\| undefined\}/);
    expect(wall).toMatch(/leavingPane\.current = lastFocusHero\.current && lastFocusHero\.current !== id/);
    expect(wall).toMatch(/const leaving = leavingPane\.current === pane\.id && parked;/);
    expect(wall).toMatch(/from\.style\.setProperty\('--collapse-inset'/);
    const pane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    expect(pane).toMatch(/if \(wasCleanStart\.current && !cleanStart && cleanStartWanted && !welcomeState\.welcome\) setExpanding\(true\);/);
  });

  it('turns both animations off for reduced motion', () => {
    const reduced = (selector: string) => cssRule(styles, selector, { media: 'prefers-reduced-motion: reduce' });
    expect(reduced(`${FOCUS_WINDOW}[data-wall-entering] > .panel`).animation).toBe('none');
    expect(reduced('.command-wall-window[data-wall-leaving] > .panel').animation).toBe('none');
    expect(reduced('[data-chat-expanding] > section').animation).toBe('none');
  });

  it('keeps the Focused selection ring calm: a muted mix, no glow', () => {
    expect(cssRule(styles, `${FOCUS_WINDOW}[data-wall-selected] > .panel`)).toEqual({
      '--panel-ring-color': `${cssValue('color-mix(in srgb, var(--accent) 28%, var(--line))')} !important`,
      'box-shadow': 'none',
    });
  });

  it('marks the selected window in Focus, so that ring applies', async () => {
    const html = (await loadWall()).render({ ...two, layout: { mode: 'focus', cols: 2, rows: 1 }, hero: 'a' }, { sessions: [summary('a'), summary('b')], selectedId: 'a' });
    expect(html).toContain('data-wall-layout="focus"');
    expect(windowTag(html, 'a')).toContain('data-wall-selected="true"');
    expect(windowTag(html, 'b')).not.toContain('data-wall-selected');
  });
});

describe('Monitors dock header', () => {
  it('reads Monitors, not Panels', async () => {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { DEFAULT_WALL_STATE } = await import('../commandWall.js');
    const { MonitorsDock } = await import('./MonitorsDock.js');
    const html = renderToStaticMarkup(React.createElement(MonitorsDock, {
      state: DEFAULT_WALL_STATE, setState: vi.fn(), tasks: [], running: new Set(), now: 0, sessions: [], providers: [], usage: null,
      vitals: { working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] }, onOpenChat: vi.fn(), onOpenModels: vi.fn(),
    } as never));
    expect(html).toContain('<strong>Monitors</strong>');
    expect(html).not.toContain('<strong>Panels</strong>');
  });
});

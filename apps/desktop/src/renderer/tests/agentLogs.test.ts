import { readFileSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { LOGS_DRAWER_INSET, layoutWithLogsDrawer, logsDrawerWidth, overlayLogsDrawer, useWallLogs, type Rect } from '../wallLogs.js';

const source = readFileSync(new URL('../components/ChatPane.tsx', import.meta.url), 'utf8');
const wall = readFileSync(new URL('../components/CommandWall.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const drawer = readFileSync(new URL('../components/AgentLogsDrawer.tsx', import.meta.url), 'utf8');

beforeEach(() => useWallLogs.setState({ sessionId: null, kind: 'logs', closing: false }));

it('keeps owning-session logs available without the compact-pane visibility gate', () => {
  const start = source.indexOf('aria-label="Open agent logs"');
  expect(start).toBeGreaterThan(0);
  const control = source.slice(source.lastIndexOf('<button', start), source.indexOf('</button>', start));
  expect(control).toContain('openTerminalPane(`agent_${sessionId}`)');
  expect(control).toContain("compact ? <TerminalIcon");
  expect(source.slice(source.lastIndexOf('</button>', start) + 9, start)).not.toContain('!compact');
});

it('opens the log as a wall drawer, not an overlay inside the chat', () => {
  const start = source.indexOf('aria-label="Open agent logs"');
  const control = source.slice(source.lastIndexOf('<button', start), source.indexOf('</button>', start));
  expect(control).toContain('commandCenter ? useWallLogs.getState().toggle(sessionId) : useStore.getState().openTerminalPane(`agent_${sessionId}`)');
  // The chat no longer draws the log over its own transcript.
  expect(source).not.toContain('AgentLogs');
  expect(wall).toContain('<AgentLogsDrawer');
  expect(wall).toContain('layoutWithLogsDrawer(geometry.panes');
  expect(drawer).toContain('<TerminalPane terminalId={`agent_${sessionId}`} />');
});

it('looks joined to its window and animates out and back in', () => {
  expect(css).toMatch(/\.agent-logs-drawer-inner \{[^}]*border-left: 0;/);
  expect(css).toContain('@keyframes agent-logs-drawer-out');
  expect(css).toContain('@keyframes agent-logs-drawer-in');
  expect(css).toContain('.agent-logs-drawer[data-closing]');
  // The window keeps its rounded corners; concave fillets flow its edge into the drawer.
  expect(css).not.toContain('.command-wall-window[data-wall-logs-open] > .panel');
  expect(css).toMatch(/\.agent-logs-drawer:not\(\[data-overlay\]\)::before \{[^}]*radial-gradient\(circle at 100% 0/);
  expect(css).toMatch(/\.agent-logs-drawer:not\(\[data-overlay\]\)::after \{[^}]*radial-gradient\(circle at 100% 100%/);
  expect(css).toContain('--logs-fillet: 12px;');
});

it('is a quarter wider than the original 32% / 340-560px drawer', () => {
  expect(logsDrawerWidth(1000)).toBe(425);
  expect(logsDrawerWidth(1500)).toBe(600);
  expect(logsDrawerWidth(3000)).toBe(700);
});

it('toggles one drawer at a time and keeps it mounted while it closes', () => {
  const s = useWallLogs.getState;
  s().toggle('a');
  expect(s()).toMatchObject({ sessionId: 'a', closing: false });
  s().toggle('b');
  expect(s()).toMatchObject({ sessionId: 'b', closing: false });
  s().toggle('b');
  expect(s()).toMatchObject({ sessionId: 'b', closing: true });
  s().closed();
  expect(s()).toMatchObject({ sessionId: null, closing: false });
});

const two = (): Map<string, Rect> => new Map([
  ['left', { x: 0, y: 0, width: 996, height: 1000 }],
  ['right', { x: 1004, y: 0, width: 996, height: 1000 }],
]);

it('hangs the drawer off the right edge, inset past the corners, and pushes the window beside it', () => {
  const { panes, drawer } = layoutWithLogsDrawer(two(), 'left', 2000);
  const w = logsDrawerWidth(2000);
  expect(drawer).toEqual({ x: 996, y: LOGS_DRAWER_INSET, width: w, height: 1000 - 2 * LOGS_DRAWER_INSET });
  expect(panes.get('left')).toEqual(two().get('left'));
  const right = panes.get('right')!;
  // The 8px gap between them stays, scaled with the squeeze.
  expect(right.x).toBeGreaterThanOrEqual(996 + w);
  expect(right.x).toBeLessThan(996 + w + 8);
  // Squeezed into what is left of the stage rather than pushed off it.
  expect(right.x + right.width).toBeCloseTo(2000, 5);
});

it('narrows the rightmost window instead of pushing anything off the wall', () => {
  const { panes, drawer } = layoutWithLogsDrawer(two(), 'right', 2000);
  expect(panes.get('left')).toEqual(two().get('left'));
  const right = panes.get('right')!;
  expect(right.width).toBeLessThan(996);
  expect(drawer!.x).toBe(right.x + right.width);
  expect(drawer!.x + drawer!.width).toBeLessThanOrEqual(2000);
});

it('keeps three windows in a row on the wall, narrowing the drawer before pushing any off', () => {
  const row = new Map<string, Rect>([
    ['a', { x: 0, y: 0, width: 518, height: 700 }],
    ['b', { x: 526, y: 0, width: 518, height: 700 }],
    ['c', { x: 1052, y: 0, width: 518, height: 700 }],
  ]);
  const { panes, drawer } = layoutWithLogsDrawer(row, 'a', 1570);
  const c = panes.get('c')!;
  expect(c.x + c.width).toBeLessThanOrEqual(1570 + 1e-6);
  expect(panes.get('b')!.width).toBeGreaterThanOrEqual(240 - 1e-6);
  expect(drawer!.width).toBeGreaterThanOrEqual(280);
  expect(drawer!.height).toBe(700 - 2 * LOGS_DRAWER_INSET);
});

it('still opens on a one-column wall, over the window instead of beside it', () => {
  const col = new Map<string, Rect>([['a', { x: 0, y: 0, width: 800, height: 400 }]]);
  const { panes, drawer, overlay } = overlayLogsDrawer(col, 'a');
  expect(overlay).toBe(true);
  expect(panes.get('a')).toEqual(col.get('a'));
  expect(drawer).toEqual({ x: 88, y: 8, width: 700, height: 384 });
  // The wall picks the overlay below NARROW_WIDTH rather than closing the drawer.
  expect(wall).toContain('overlayLogsDrawer(geometry.panes, logsPane.id)');
});

it('leaves windows in other rows where they are', () => {
  const grid = new Map<string, Rect>([
    ['a', { x: 0, y: 0, width: 996, height: 496 }],
    ['b', { x: 1004, y: 0, width: 996, height: 496 }],
    ['c', { x: 1004, y: 504, width: 996, height: 496 }],
  ]);
  const { panes } = layoutWithLogsDrawer(grid, 'a', 2000);
  expect(panes.get('c')).toEqual(grid.get('c'));
  expect(panes.get('b')!.x).toBeGreaterThan(1004);
});

it('opens Changes, Files and Browser in the same drawer, switching kind without closing', () => {
  const s = useWallLogs.getState;
  s().toggle('a', 'diff');
  expect(s()).toMatchObject({ sessionId: 'a', kind: 'diff', closing: false });
  s().toggle('a', 'browser');
  expect(s()).toMatchObject({ sessionId: 'a', kind: 'browser', closing: false });
  s().toggle('a', 'browser');
  expect(s()).toMatchObject({ sessionId: 'a', kind: 'browser', closing: true });
  s().closed();
  s().toggle('a');
  expect(s()).toMatchObject({ sessionId: 'a', kind: 'logs', closing: false });
});

it('renders each companion kind in the drawer, and the wall buttons toggle it', () => {
  expect(drawer).toContain('<DiffPane sessionId={sessionId} />');
  expect(drawer).toContain('<BrowserPane url="about:blank" />');
  expect(drawer).toContain('<ExplorerPane');
  const buttons = readFileSync(new URL('../components/AgentCompanionButtons.tsx', import.meta.url), 'utf8');
  expect(buttons).toContain('useWallLogs.getState().toggle(sessionId, kind)');
});

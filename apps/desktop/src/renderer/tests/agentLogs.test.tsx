import { beforeEach, expect, it, vi } from 'vitest';
import './browserGlobals.js';
import { cssRule, cssValue, hasKeyframes, hasSelector, stylesheet } from './css.js';
import { liveHook, liveStore } from './liveStore.js';
import { chatSession, renderChatPane, withProvider } from './renderChatPane.js';
import { loadWall, summary } from './renderWall.js';
import { LOGS_DRAWER_INSET, layoutWithLogsDrawer, logsDrawerWidth, overlayLogsDrawer, useWallLogs, type Rect } from '../wallLogs.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../wallLogs.js', (original) => liveHook('useWallLogs')(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('../components/DiffPane.js', () => ({ DiffPane: ({ sessionId }: { sessionId: string }) => <div data-diff={sessionId} /> }));
vi.mock('../components/BrowserPane.js', () => ({ BrowserPane: ({ url }: { url: string }) => <div data-browser={url} /> }));
vi.mock('../components/ExplorerPane.js', () => ({ ExplorerPane: ({ paneId }: { paneId: string }) => <div data-explorer={paneId} /> }));

const css = stylesheet('styles.css');
beforeEach(() => { useWallLogs.setState({ sessionId: null, kind: 'logs', closing: false }); withProvider(); });

/** The Logs button in a chat's header, as rendered. */
const logsButton = (html: string) => html.match(/<button[^>]*aria-label="Open agent logs"[^>]*>[^]*?<\/button>/)?.[0] ?? '';

it('keeps owning-session logs available in a compact pane, as an icon', () => {
  const chat = chatSession();
  expect(logsButton(renderChatPane(chat, {}, false))).toContain('>Logs</button>');
  // A small window folds the label into a terminal icon but keeps the button.
  const compact = logsButton(renderChatPane(chat, {}, true));
  expect(compact).not.toBe('');
  expect(compact).toContain('<svg');
  expect(compact).not.toContain('>Logs<');
});

it('opens the log as a wall drawer, not an overlay inside the chat', async () => {
  // In the Chat view the button opens a workbench window; on the wall it is a toggle for the drawer.
  expect(logsButton(renderChatPane(chatSession(), { commandCenter: false }))).not.toContain('aria-expanded');
  const chat = chatSession();
  useWallLogs.getState().toggle(chat.id);
  const html = renderChatPane(chat, { commandCenter: false });
  // The chat never draws the log over its own transcript.
  expect(html).not.toContain('data-agent-logs');
  expect(html).not.toContain('agent-logs-drawer');
  // The wall draws it, beside the window, with the agent's terminal in it.
  const wall = (await loadWall()).render({ root: { id: 'a', kind: 'chat', refId: chat.id } as never, layout: { mode: 'grid', cols: 1, rows: 1 } }, { sessions: [summary(chat.id)] });
  expect(wall).toMatch(/<div class="agent-logs-drawer" role="dialog" aria-label="Command log for Chat [^"]+"/);
  expect(wall).toContain(`data-terminal="agent_${chat.id}"`);
});

it('looks joined to its window and slides out and back in, interruptibly', () => {
  expect(cssRule(css, '.agent-logs-drawer-inner')['border-left']).toBe('0');
  // A transition, not a pair of keyframes, so a second toggle reverses from where it is.
  expect(hasKeyframes(css, 'agent-logs-drawer-out')).toBe(false);
  expect(cssRule(css, '.agent-logs-drawer').transition).toMatch(/^clip-path 260ms var\(--ease-out\)/);
  expect(cssRule(css, '.agent-logs-drawer[data-closing]')['clip-path']).toBe('inset(0 100% 0 0)');
  expect(css.toString()).not.toContain('cubic-bezier(.55, 0, .75, .2)');
  // The window keeps its rounded corners; concave fillets flow its edge into the drawer.
  expect(hasSelector(css, /\.command-wall-window\[data-wall-logs-open\] > \.panel/)).toBe(false);
  expect(cssRule(css, '.agent-logs-drawer:not([data-overlay])')['--logs-fillet']).toBe('12px');
  expect(cssRule(css, '.agent-logs-drawer:not([data-overlay])::before').background).toMatch(/^radial-gradient\(circle at 100% 1px,/);
  expect(cssRule(css, '.agent-logs-drawer:not([data-overlay])::after').background).toMatch(/^radial-gradient\(circle at 100% calc\(100% - 1px\),/);
  // The fillets cover the drawer's own border row too, or it runs on straight under each arc.
  expect(cssRule(css, '.agent-logs-drawer:not([data-overlay])::after').height).toBe(cssValue('calc(var(--logs-fillet) + 1px)'));
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
});

it('keeps the drawer open over a narrow wall rather than closing it', async () => {
  // An unmeasured wall is narrower than NARROW_WIDTH: the drawer sits over its window.
  const chat = chatSession();
  useWallLogs.getState().toggle(chat.id);
  const wall = (await loadWall()).render({ root: { id: 'a', kind: 'chat', refId: chat.id } as never, layout: { mode: 'grid', cols: 1, rows: 1 } }, { sessions: [summary(chat.id)] });
  expect(wall).toMatch(/class="agent-logs-drawer"[^>]*data-overlay="true"/);
  expect(useWallLogs.getState().sessionId).toBe(chat.id);
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

it('renders each companion kind in the drawer, and the wall buttons toggle it', async () => {
  const { AgentLogsDrawer } = await import('../components/AgentLogsDrawer.js');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const rect = { x: 0, y: 0, width: 400, height: 300 };
  const body = (kind: 'diff' | 'files' | 'browser') => {
    useWallLogs.setState({ sessionId: 's', kind, closing: false });
    return renderToStaticMarkup(<AgentLogsDrawer sessionId="s" title="Chat" rect={rect} />);
  };
  expect(body('diff')).toContain('data-diff="s"');
  expect(body('browser')).toContain('data-browser="about:blank"');
  expect(body('files')).toContain('data-explorer="drawer_s"');
  // On the wall, each companion button toggles that kind of drawer for its chat.
  const { openAgentCompanion } = await import('../components/AgentCompanionButtons.js');
  useWallLogs.setState({ sessionId: null, kind: 'logs', closing: false });
  openAgentCompanion('s', 'browser', true);
  expect(useWallLogs.getState()).toMatchObject({ sessionId: 's', kind: 'browser', closing: false });
  openAgentCompanion('s', 'browser', true);
  expect(useWallLogs.getState().closing).toBe(true);
});

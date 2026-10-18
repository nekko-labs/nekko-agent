import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { cssRule, hasSelector, stylesheet } from '../tests/css.js';
import { liveStore } from '../tests/liveStore.js';
import { agentSummary, renderSidebar } from '../tests/renderSidebar.js';
import { AGENT_PANEL_VIEW_KEY, DEFAULT_AGENT_PANEL_VIEW } from './agentPanelView.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));

const css = stylesheet('styles.css');
const header = (html: string) => html.slice(html.indexOf('data-agent-panel-header'), html.indexOf('data-agent-panel-list'));
const tag = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';

beforeEach(() => localStorage.removeItem(AGENT_PANEL_VIEW_KEY));

describe('Agents panel header', () => {
  it('hides with a left-panel icon rather than an X, and swaps sides with the curved-arrow icon', () => {
    for (const orientation of ['vertical', 'horizontal'] as const) {
      const head = header(renderSidebar({ orientation }));
      expect(head, orientation).toContain('aria-label="Hide the agent panel"');
      expect(head).toMatch(/aria-label="Show agents in a (row|column)"/);
      expect(head).not.toContain('Close the agent panel');
      // The X glyph (CloseIcon) appears nowhere in the header.
      expect(head).not.toContain('M18 6 6 18M6 6l12 12');
    }
  });

  it('keeps the panel controls where the panel was when it is collapsed, and nowhere in the title bar', async () => {
    const { loadCommandCenter } = await import('../tests/renderCommandCenter.js');
    const page = await loadCommandCenter();
    const collapsed = page.render({ commandWall: { agentPanel: { show: false, orientation: 'vertical' } } as never });
    const toolbar = collapsed.slice(0, collapsed.indexOf('class="wall-workspace"'));
    expect(toolbar).not.toContain('agent panel');
    expect(collapsed).toMatch(/<div class="agent-panel-collapsed" data-orientation="vertical"><div class="agent-panel-controls"[^>]*>[^]*aria-label="Show the agent panel"/);
  });

  it('draws no outer ring around the Agents tab panel in either orientation', () => {
    for (const orientation of ['vertical', 'horizontal'] as const) {
      const panel = renderSidebar({ orientation }).match(/<div class="panel [^"]*" [^>]*data-agent-panel="true"/)?.[0] ?? '';
      expect(panel, orientation).not.toBe('');
      expect(panel).not.toMatch(/\bpanel-ring\b/);
    }
  });

  it('renders the + in the accent, a size up', () => {
    const plus = renderSidebar().match(/<button class="agent-panel-plus [^"]*"[^>]*aria-label="New agent"[^>]*><svg[^>]*class="h-\[22px\] w-\[22px\]"/);
    expect(plus).not.toBeNull();
    expect(cssRule(css, '.agent-panel-plus').color).toBe('var(--accent)');
  });

  // Source pins, pending an agents-panel e2e journey: the + menu and the view
  // menu open on pointer and context-menu events, which a server render never fires.
  it('portals the + menu above the wall and opens the view menu from a group header right-click (source pin)', () => {
    const source = readFileSync(new URL('./WorkspacesView.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/newMenuOpen && newMenuPos && createPortal\(/);
    expect(source).toMatch(/className="card fixed z-\[1000\] w-64 p-1\.5 shadow-lg"/);
    expect(source).toMatch(/onContextMenu=\{sidebarOnly \? \(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); setViewMenu\(\{ x: e\.clientX, y: e\.clientY \}\)/);
    expect(source).toMatch(/<AgentPanelViewMenu x=\{viewMenu\.x\} y=\{viewMenu\.y\}/);
  });

  it('offers the view menu from the sliders button, and says so on each group header', () => {
    const html = renderSidebar();
    expect(tag(header(html), 'Agent panel view options')).toContain('aria-haspopup="menu"');
    expect(header(html)).toMatch(/aria-label="Agent panel view options"[^>]*><svg[^>]*class="h-4 w-4"/);
    expect(html).toMatch(/title="Drag to reorder project · right-click for view options"/);
  });

  it('only drags cards into order where that order is what the panel shows', () => {
    const cards = (html: string) => [...html.matchAll(/<div data-completion-row="[^"]+" draggable="(true|false)"/g)].map((m) => m[1]);
    const sessions = [agentSummary('a'), agentSummary('b')];
    expect(cards(renderSidebar({ sessions }))).toEqual(['true', 'true']);
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, sortBy: 'name' }));
    const byName = renderSidebar({ sessions });
    expect(cards(byName)).toEqual(['false', 'false']);
    // Project headers stay draggable while grouped by project.
    expect(byName).toMatch(/<div class="group flex items-center[^"]*" draggable="true"/);
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'status' }));
    expect(renderSidebar({ sessions })).not.toMatch(/<div class="group flex items-center[^"]*" draggable="true"/);
  });

  it('puts a search button beside the +, styled and sized like the view-options sliders, opening the chat finder', () => {
    const head = header(renderSidebar());
    const order = [...head.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(order.slice(-3)).toEqual(['Agent panel view options', 'Search chats', 'New agent']);
    const search = tag(head, 'Search chats');
    expect(search).toContain('data-chat-finder-toggle');
    expect(search).toContain('aria-haspopup="dialog"');
    // The same classes as the sliders button: one look for the two icon buttons.
    const cls = (t: string) => t.match(/class="([^"]+)"/)![1];
    expect(cls(search)).toBe(cls(tag(head, 'Agent panel view options')));
    expect(head).toMatch(/aria-label="Search chats"[^>]*><svg[^>]*class="h-4 w-4"/);
  });

  it('keeps the composer row to the composer alone in either docking position; adding lives in the toolbar', async () => {
    const { loadCommandCenter } = await import('../tests/renderCommandCenter.js');
    const page = await loadCommandCenter();
    for (const side of ['top', 'bottom'] as const) {
      const html = page.render({ commandWall: { composer: { side, align: 'center' } } as never });
      expect(html, side).toMatch(new RegExp(`<div class="wall-composer-row" data-dock="${side}-center"><div data-stub="composer"></div></div>`));
    }
    const html = page.render();
    expect(html).toMatch(/<div class="wall-add-bar" role="group" aria-label="Add to the wall">/);
    expect(cssRule(css, '.wall-add-bar').display).toBe('inline-flex');
    for (const gone of [/\.wall-add-arrow/, /\.wall-add-launch/]) expect(hasSelector(css, gone)).toBe(false);
    expect(cssRule(css, '.wall-composer-row')['flex-direction']).toBeUndefined();
  });
});

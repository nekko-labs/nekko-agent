import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cssRule, hasSelector, stylesheet } from '../tests/css.js';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE, type CommandWallState } from '../commandWall.js';
import { type WbPane } from '../layout.js';
import type { Workspace } from '../store.js';

const fixture = vi.hoisted(() => ({ workspaces: [] as Workspace[], streamItems: 2 }));
vi.mock('../store.js', () => ({ useStore: (select: (s: { workspaces: Workspace[] }) => unknown) => select(fixture) }));
vi.mock('./ChatPane.js', () => ({ ChatPane: () => <ul>{Array.from({ length: fixture.streamItems }, (_, i) => <li key={i}>Stream item {i}</li>)}</ul> }));
vi.mock('./TerminalPane.js', () => ({ TerminalPane: ({ terminalId }: { terminalId: string }) => <div data-terminal={terminalId} /> }));
vi.mock('./FilePane.js', () => ({ FilePane: ({ path }: { path: string }) => <div data-file={path} /> }));
vi.mock('./ExplorerPane.js', () => ({ ExplorerPane: ({ paneId }: { paneId: string }) => <div data-explorer={paneId} /> }));
vi.mock('./BrowserPane.js', () => ({ BrowserPane: ({ url }: { url: string }) => <div data-browser={url} /> }));
vi.mock('./DiffPane.js', () => ({ DiffPane: ({ sessionId }: { sessionId: string }) => <div data-diff={sessionId} /> }));
vi.mock('./PaneFrame.js', () => ({
  PaneFrame: ({ title, children }: { title: string; children: React.ReactNode }) => <section data-title={title}>{children}</section>,
  PaneActions: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
import { CommandWall } from './CommandWall.js';

const a: WbPane = { id: 'a', kind: 'chat', refId: 'chat-a' };
const state = (patch: Partial<CommandWallState> = {}): CommandWallState => ({ ...DEFAULT_WALL_STATE, root: a, layout: { mode: 'grid', cols: 3, rows: 2 }, folded: {}, ...patch });

function wall(s: CommandWallState, addContent?: React.ReactNode) {
  return <CommandWall state={s} setState={vi.fn()} sessions={[]} terminals={[]} running={new Set()} pending={{}} childrenOf={new Map()} projects={[]} flash={null} selectedId={null} onSelect={vi.fn()} onAspect={vi.fn()} onOpenChat={vi.fn()} onOpenTerminal={vi.fn()} onNewChat={vi.fn()} onNewTerminal={vi.fn()} onAddWindow={vi.fn()} addContent={addContent} />;
}

describe('wall vacancy is state-owned, not descendant-owned', () => {
  it('marks only a genuinely empty idle stage vacant', () => {
    const html = renderToStaticMarkup(wall(state({ root: null })));
    expect(html).toContain('data-wall-vacant="true"');
    expect(html).toContain('data-wall-empty');
  });
  it('does not center a filtered no-match stage', () => {
    const html = renderToStaticMarkup(wall(state({ root: a, filter: 'terminal' })));
    expect(html).not.toContain('data-wall-vacant');
    expect(html).toContain('No windows match this filter.');
  });
  it('keeps creation tiles out of empty styling', () => {
    const html = renderToStaticMarkup(wall(state({ root: null }), <div>Create agent</div>));
    expect(html).not.toContain('data-wall-vacant');
    expect(html).not.toContain('data-wall-empty');
    expect(html).toContain('command-wall-add-tile');
  });
  it('centres the empty state off the stage attribute, not a descendant :has', () => {
    const css = stylesheet('components/commandWallLayouts.css');
    expect(cssRule(css, '.command-wall-stage[data-wall-vacant] > .command-wall-empty')).toMatchObject({ display: 'flex', 'align-items': 'center', 'justify-content': 'center' });
    expect(hasSelector(css, /:has\([^)]*(?:data-wall-empty|command-wall-empty-state)/)).toBe(false);
  });
  it('keeps vacancy absent while streamed list descendants grow', () => {
    fixture.streamItems = 2;
    const before = renderToStaticMarkup(wall(state({ root: a })));
    fixture.streamItems = 10;
    const after = renderToStaticMarkup(wall(state({ root: a })));
    expect(before.match(/<li/g)).toHaveLength(2);
    expect(after.match(/<li/g)).toHaveLength(10);
    expect(before).not.toContain('data-wall-vacant');
    expect(after).not.toContain('data-wall-vacant');
    fixture.streamItems = 2;
  });
});

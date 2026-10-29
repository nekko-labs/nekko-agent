import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { cssRule, stylesheet } from '../tests/css.js';
import { liveStore } from '../tests/liveStore.js';
import { chatSession, renderChatPane, withProvider } from '../tests/renderChatPane.js';
import { loadWall, summary, windowTag } from '../tests/renderWall.js';
import { renderWallComposer } from '../tests/renderWallComposer.js';
import { agentSummary, renderSidebar } from '../tests/renderSidebar.js';
import { InternetToggle, ToolsList } from '../components/ChatControls.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));
const { statusFromEvent } = await import('./WorkspacesView.js');

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('agent status from events', () => {
  it('shows needs-input for a question as well as an approval', () => {
    expect(statusFromEvent('question')).toBe('input');
    expect(statusFromEvent('tool_approval_required')).toBe('input');
  });
  it('keeps the ? while a parked turn streams, and clears it when answered', () => {
    expect(statusFromEvent('text', 'input')).toBeUndefined();
    expect(statusFromEvent('step', 'input')).toBeUndefined();
    expect(statusFromEvent('question_resolved', 'input')).toBe('working');
    expect(statusFromEvent('tool_result', 'input')).toBe('working');
    expect(statusFromEvent('text')).toBe('working');
    expect(statusFromEvent('done', 'input')).toBeNull();
    expect(statusFromEvent('error')).toBe('error');
    expect(statusFromEvent('session_meta')).toBeUndefined();
    expect(statusFromEvent('session_meta', 'input')).toBeUndefined();
  });
  // Source pin, pending an agents-panel e2e journey: the seeding is a mount effect
  // waiting on a host promise, which a server render never runs.
  it('seeds waiting chats from the host on mount (source pin)', () => {
    expect(read('./WorkspacesView.tsx')).toMatch(/window\.nekko\.pendingInput\(\)\.then\(\(pending\) => setStatuses/);
  });
});

describe('agent window indicators', () => {
  it('shows a done check without watches and idle only for a watched sidebar chat', () => {
    const html = renderSidebar({ sessions: [agentSummary('done', { activeWatchCount: 0 }), agentSummary('watched', { activeWatchCount: 1 })] });
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain('aria-label="Idle, watching"');
    const afterCancel = renderSidebar({ sessions: [agentSummary('watched', { activeWatchCount: 0 })] });
    expect(afterCancel).toContain('aria-label="Done"');
    expect(afterCancel).not.toContain('aria-label="Idle, watching"');
  });

  const two = { root: { id: 'r', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'a', kind: 'chat', refId: 'a' }, { id: 'b', kind: 'chat', refId: 'b' }] } as never, layout: { mode: 'grid' as const, cols: 2, rows: 1 } };

  it('wears the warm attention ring when waiting on you', async () => {
    const wall = (await loadWall()).render(two, { sessions: [summary('a'), summary('b')], pending: { a: { sessionId: 'a', approval: { call: { id: 'c', name: 'bash', input: {} }, reason: 'r', severity: 'high', requestedAt: 0 } } } });
    expect(windowTag(wall, 'a')).toContain('data-wall-needs-you="true"');
    expect(windowTag(wall, 'b')).not.toContain('data-wall-needs-you');
    const css = stylesheet('styles.css');
    for (const selector of ['.command-wall-window[data-wall-needs-you] > .panel', '.command-wall-layout[data-wall-layout] .command-wall-window[data-wall-needs-you] > .panel']) {
      expect(cssRule(css, selector)['--panel-ring-color'], selector).toBe('var(--warning) !important');
    }
  });

  it('replaces the Online label with an internet toggle and moves Tools and MCP to the footer', () => {
    withProvider();
    const html = renderChatPane(chatSession());
    expect(html).not.toMatch(/>Online</);
    expect(html).not.toMatch(/>Offline</);
    const footer = html.slice(html.indexOf('data-agent-footer-controls'));
    const order = [...footer.matchAll(/(class="ctl-menu-label">(Tools|MCP)<|class="agent-internet-toggle)/g)].map((m) => m[2] ?? 'internet');
    expect(order).toEqual(['Tools', 'MCP', 'internet']);
    // The controls strip at the top of the composer no longer carries them.
    const top = html.slice(html.indexOf('class="composer relative"'), html.indexOf('composer-editing-body'));
    expect(top).not.toMatch(/>Tools</);
    expect(top).not.toMatch(/>MCP</);
  });

  it('blocks and allows the internet from one toggle, locked on for a cloud model', () => {
    const toggle = (session: object | null, cloudModel = false) => renderToStaticMarkup(<InternetToggle session={session as never} cloudModel={cloudModel} onToggle={() => {}} />);
    expect(toggle({ offline: false })).toContain('Click to block internet connectivity (local tools keep working).');
    expect(toggle({ offline: true })).toContain('Click to allow internet connectivity.');
    // A cloud model needs the internet: blocking stays local-only, as Offline was; an already-blocked chat can be allowed.
    expect(toggle({ offline: false }, true)).toContain('disabled=""');
    expect(toggle({ offline: true }, true)).not.toContain('disabled=""');
  });

  it('keeps the Tools menu usable while the internet is blocked, grouped by category', () => {
    const tools = [{ name: 'read_file', description: 'Read.' }, { name: 'web_fetch', description: 'Fetch.' }];
    const html = renderToStaticMarkup(<ToolsList session={{ id: 's', offline: true } as never} onChange={() => {}} tools={tools} />);
    expect(html.match(/role="group"/g)?.length).toBeGreaterThan(1);
    expect(html).toMatch(/<button[^>]*data-tool-name="read_file"[^>]*>/);
    expect(html.match(/<button[^>]*data-tool-name="read_file"[^>]*>/)![0]).not.toContain('disabled=""');
  });

  it('drops the Continue work box from every composer', () => {
    withProvider();
    // Recovery remains in the error banner, never a suggested-response row.
    expect(renderChatPane(chatSession(), { surface: 'full' })).not.toContain('>Continue work</button>');
    expect(renderWallComposer()).not.toContain('Continue work');
  });
});

describe('chat panel groups', () => {
  it('hides a closed group\'s cards completely and keeps them out of the tab order', () => {
    const board = stylesheet('components/commandWallLayouts.css');
    expect(cssRule(board, '.agent-panel-row .collapse-wrap.collapsed').display).toBe('none');
    expect(cssRule(board, '[data-agent-panel] .collapse-wrap.collapsed')).toMatchObject({ visibility: 'hidden', 'pointer-events': 'none' });
    // Source pin: groups collapse on click (pane state); the rendered open group is not inert.
    expect(read('./WorkspacesView.tsx')).toMatch(/inert=\{isCollapsed \|\| undefined\}/);
    expect(renderSidebar({ sessions: [agentSummary('a')] })).toMatch(/<div class="collapse-wrap " data-group-cards="true">/);
  });
  // Source pin: wheel scrolling needs a DOM event; the row layout itself is rendered.
  it('turns the wheel into sideways scrolling in the row (source pin)', () => {
    expect(renderSidebar({ orientation: 'horizontal' })).toContain('class="agent-panel-row ');
    expect(read('./WorkspacesView.tsx')).toMatch(/onWheel=\{horizontal \? scrollRowWithWheel : undefined\}/);
  });
});

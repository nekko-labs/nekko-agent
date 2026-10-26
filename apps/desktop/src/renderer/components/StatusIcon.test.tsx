import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { chatSession, renderChatPane, withProvider } from '../tests/renderChatPane.js';
import { loadWall, summary, windowBody } from '../tests/renderWall.js';
import { renderWallComposer } from '../tests/renderWallComposer.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('../useGitStatus.js', () => ({ useGitStatus: () => null }));
import { StatusIcon, agentStatusOfLane } from './WorkspaceCard.js';

describe('agent status glyphs', () => {
  it('maps board lanes to the sidebar glyphs', () => {
    expect(agentStatusOfLane('working')).toBe('working');
    expect(agentStatusOfLane('idle')).toBe('done');
    expect(agentStatusOfLane('idle', undefined, 1)).toBe('idle');
    for (const count of [0, 1, 3]) {
      expect(agentStatusOfLane('working', undefined, count)).toBe('working');
      expect(agentStatusOfLane('needs-you', 'question', count)).toBe('input');
      expect(agentStatusOfLane('needs-you', 'approval', count)).toBe('input');
      expect(agentStatusOfLane('needs-you', 'interrupted', count)).toBe('error');
    }
    expect(agentStatusOfLane('needs-you', 'question')).toBe('input');
    expect(agentStatusOfLane('needs-you', 'approval')).toBe('input');
    expect(agentStatusOfLane('needs-you', 'interrupted')).toBe('error');
  });

  it('draws a gray check when done and Zz only when idle with a watch', () => {
    const working = renderToStaticMarkup(<StatusIcon status="working" />);
    expect(working).toContain('status-rocket');
    expect(working).toContain('rocket-flame');
    const done = renderToStaticMarkup(<StatusIcon status={undefined} />);
    expect(done).toContain('aria-label="Done"');
    expect(done).toContain('text-ink-faint');
    expect(done).not.toContain('>Zz<');
    const idle = renderToStaticMarkup(<StatusIcon status="idle" />);
    expect(idle).toContain('aria-label="Idle, watching"');
    expect(idle).not.toContain('rounded-full');
  });

  it('uses the glyphs in wall window strips, before the numbered agent icon', async () => {
    const wall = (await loadWall()).render(
      { root: { id: 'r', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'a', kind: 'chat', refId: 'a' }, { id: 'b', kind: 'chat', refId: 'b' }] } as never, layout: { mode: 'grid', cols: 2, rows: 1 } },
      { sessions: [summary('a'), summary('b')], running: ['a'] },
    );
    expect(windowBody(wall, 'a')).toMatch(/data-frame-icon="true"><span data-agent-status="true"><span class="status-rocket[^]*?<\/span><\/span><span class="numbered-agent-icon"/);
    expect(windowBody(wall, 'b')).toMatch(/data-agent-status="true"><span[^>]*aria-label="Done"/);
    // The window passes the status to the chat as a value, and the chat draws no footer copy of it.
    expect(windowBody(wall, 'a')).toContain('data-status="working"');
    expect(windowBody(wall, 'b')).toContain('data-status="done"');
    withProvider();
    expect(renderChatPane(chatSession(), { commandCenter: true, status: 'working' })).not.toContain('agent-footer-status');
  });

  it('forwards watch counts to real wall strips without hiding working or input', async () => {
    const wall = (await loadWall()).render(
      { root: { id: 'r', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'a', kind: 'chat', refId: 'a' }, { id: 'b', kind: 'chat', refId: 'b' }] } as never, layout: { mode: 'grid', cols: 2, rows: 1 } },
      { sessions: [summary('a', { activeWatchCount: 1 }), summary('b', { activeWatchCount: 0 })] },
    );
    expect(windowBody(wall, 'a')).toContain('aria-label="Idle, watching"');
    expect(windowBody(wall, 'b')).toContain('aria-label="Done"');
  });

  it('uses the glyph in the wall composer, not a pulsing dot', () => {
    withProvider();
    const html = renderWallComposer({ agent: { glyph: 'working' } });
    const head = html.slice(html.indexOf('data-composer-head'));
    expect(head).toContain('status-rocket');
    expect(html).not.toContain('animate-pulse rounded-full');
  });
});

describe('wall chat chrome', () => {
  it('never draws a second title row inside a wall window', () => {
    withProvider();
    // On the wall the chat's actions join the window's strip; there is no <header> of its own.
    expect(renderChatPane(chatSession(), { commandCenter: true })).not.toContain('<header');
    expect(renderChatPane(chatSession(), { commandCenter: false })).toContain('<header');
  });

  it('draws no empty strip under the wall composer', () => {
    withProvider();
    const html = renderChatPane(chatSession(), { surface: 'composer', commandCenter: true });
    expect(html).toMatch(/<div class="shrink-0" aria-label="Chat actions and information"><\/div>/);
    expect(html).not.toMatch(/border-t border-line bg-surface px-3 py-1\.5" aria-label="Chat actions and information"/);
  });
});

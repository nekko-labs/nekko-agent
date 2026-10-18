import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { withProvider } from '../tests/renderChatPane.js';
import { renderWallComposer } from '../tests/renderWallComposer.js';
import { ChatControls } from './ChatControls.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));

/** The opening tag and contents of the element carrying `attr`, to its first closing </div> depth match. */
function region(html: string, attr: string): string {
  const start = html.lastIndexOf('<div', html.indexOf(attr));
  let depth = 0;
  for (const m of html.slice(start).matchAll(/<(\/)?div\b/g)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, start + m.index! + 6);
  }
  return html.slice(start);
}

beforeEach(() => withProvider());

describe('wall composer layout', () => {
  it('has no bar above the composer: the agent row is the composer’s own first row', () => {
    const html = renderWallComposer();
    // Exactly one head row, inside the composer card.
    expect(html.match(/data-composer-head/g)).toHaveLength(1);
    expect(html.indexOf('class="composer relative"')).toBeLessThan(html.indexOf('data-composer-head'));
    expect(region(html, 'data-composer-head')).toContain('data-composer-title');
    // Without an agent the same row stands alone over the empty state.
    const none = renderWallComposer({ agent: null });
    expect(none.match(/data-composer-head/g)).toHaveLength(1);
    expect(region(none, 'data-composer-head')).toContain('No agent selected');
    expect(none).not.toContain('class="composer relative"');
  });

  it('replaces the controls strip with that row, with Automate at its right end', () => {
    const html = renderWallComposer();
    const head = region(html, 'data-composer-head');
    const buttons = [...head.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(buttons.at(-1)).toBe('Automate: schedule, repeat, or run in the background');
    // The full chat's controls strip (with its own Automate) is not drawn as well.
    expect(html.match(/Automate: schedule/g)).toHaveLength(2); // aria-label and title of the one button
  });

  it('puts mode and incognito in the bottom bar beside +', () => {
    const html = renderWallComposer();
    const foot = region(html, 'data-composer-foot');
    expect(foot).toContain('data-chat-mode-button');
    expect(foot).toContain('Incognito');
    expect(html.indexOf('aria-label="Add a photo, video, file, folder, or skill"')).toBeLessThan(html.indexOf('data-composer-foot'));
    // Tools and MCP stay in the window, not in the composer's foot.
    expect(foot).not.toMatch(/>Tools</);
    expect(foot).not.toMatch(/>MCP</);
  });

  it('lets ChatControls render just the mode menu or just the privacy switch', () => {
    const session = { id: 's', title: 'Chat', messages: [], createdAt: 0, updatedAt: 0 } as never;
    const mode = renderToStaticMarkup(<ChatControls session={session} isCloudModel={false} onChange={() => {}} only="mode" />);
    const privacy = renderToStaticMarkup(<ChatControls session={session} isCloudModel={false} onChange={() => {}} only="privacy" />);
    const all = renderToStaticMarkup(<ChatControls session={session} isCloudModel={false} onChange={() => {}} />);
    expect(mode).toContain('data-chat-mode-button');
    expect(mode).not.toContain('Incognito');
    expect(privacy).toContain('Incognito');
    expect(privacy).not.toContain('data-chat-mode-button');
    // Only the full strip carries Tools and MCP; an image chat has no mode menu.
    for (const part of [mode, privacy]) { expect(part).not.toMatch(/>Tools</); expect(part).not.toMatch(/>MCP</); }
    expect(all).toMatch(/>Tools</);
    expect(all).toMatch(/>MCP</);
    expect(renderToStaticMarkup(<ChatControls session={{ ...(session as object), chatType: 'image' } as never} isCloudModel={false} onChange={() => {}} only="mode" />)).not.toContain('data-chat-mode-button');
    const sandboxed = renderToStaticMarkup(<ChatControls session={{ ...(session as object), executionMode: 'sandbox' } as never} isCloudModel={false} onChange={() => {}} />);
    expect(sandboxed).toContain('MCP unavailable');
  });

  it('drops the keyboard hint from the row into the title tooltip', () => {
    const html = renderWallComposer({ agents: 3 });
    expect(html).not.toContain('Ctrl+Tab cycles windows · Ctrl+1…9 selects a window');
    expect(html).toMatch(/data-composer-title="true" title="Wall agent · Ctrl\+Tab cycles windows, Ctrl\+1…9 selects one"/);
    // One agent: nothing to cycle, so no hint.
    expect(renderWallComposer({ agents: 1 })).toMatch(/data-composer-title="true" title="Wall agent"/);
  });
});

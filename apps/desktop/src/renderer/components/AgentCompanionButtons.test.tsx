import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { chatSession, renderChatPane } from '../tests/renderChatPane.js';
import { chatFolderPath } from '../store.js';
import { AgentCompanionButtons } from './AgentCompanionButtons.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));

describe('agent companion buttons', () => {
  it('offers Changes, Files and Browser in the agent header, with the change count on Changes', () => {
    const html = renderToStaticMarkup(<AgentCompanionButtons sessionId="s" changeCount={3} commandCenter compact={false} />);
    expect(html).toContain('aria-label="Changes (3)"');
    expect(html).toContain('aria-label="Files"');
    expect(html).toContain('aria-label="Browser"');
    expect(html).toContain('>3 files<');
    expect(html).toContain('agent-changes-pending');
    expect(html).toContain('+0');
    const none = renderToStaticMarkup(<AgentCompanionButtons sessionId="s" changeCount={0} commandCenter compact={false} />);
    expect(none).toContain('aria-label="Changes"');
  });

  it('sits beside Logs in the chat header', () => {
    const html = renderChatPane(chatSession());
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    // Changes, Files and Browser come straight before Logs: no other control between them.
    const buttons = [...header.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    const logs = buttons.indexOf('Open agent logs');
    expect(logs).toBeGreaterThan(0);
    expect(buttons.slice(logs - 3, logs)).toEqual(['Changes', 'Files', 'Browser']);
  });
});

describe('chatFolderPath', () => {
  const settings = { workspaces: [{ id: 'a', name: 'app', path: 'C:\\code\\app', addedAt: 0 }, { id: 'b', name: 'lib', path: 'C:\\code\\lib', addedAt: 0 }] } as any;
  it("opens the chat's own checkout first, then its primary folder, then a supporting one", () => {
    const s = (chat: object) => ({ settings, sessions: [{ id: 's', ...chat }] as any });
    expect(chatFolderPath(s({ workspaceId: 'a', gitWorktrees: { a: { path: 'C:\\wt\\s' } } }), 's')).toBe('C:\\wt\\s');
    expect(chatFolderPath(s({ workspaceId: 'a' }), 's')).toBe('C:\\code\\app');
    expect(chatFolderPath(s({ supportingWorkspaceIds: ['gone', 'b'] }), 's')).toBe('C:\\code\\lib');
    expect(chatFolderPath(s({}), 's')).toBe('');
  });
});

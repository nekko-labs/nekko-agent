import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: { dispatchEvent: () => true }, localStorage: { getItem: () => null } }); });
import { chatFolderPath } from '../store.js';
import { AgentCompanionButtons } from './AgentCompanionButtons.js';
import { readFileSync } from 'node:fs';

describe('agent companion buttons', () => {
  it('offers Changes, Files and Browser in the agent header, with the change count on Changes', () => {
    const html = renderToStaticMarkup(<AgentCompanionButtons sessionId="s" changeCount={3} commandCenter compact={false} />);
    expect(html).toContain('aria-label="Changes (3)"');
    expect(html).toContain('aria-label="Files"');
    expect(html).toContain('aria-label="Browser"');
    expect(html).toContain('>3<');
    const none = renderToStaticMarkup(<AgentCompanionButtons sessionId="s" changeCount={0} commandCenter compact={false} />);
    expect(none).toContain('aria-label="Changes"');
  });

  it('sits beside Logs in the chat header', () => {
    const pane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    const buttons = pane.indexOf('<AgentCompanionButtons');
    const logs = pane.indexOf('aria-label="Open agent logs"');
    expect(buttons).toBeGreaterThan(0);
    expect(logs - buttons).toBeGreaterThan(0);
    expect(logs - buttons).toBeLessThan(400);
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

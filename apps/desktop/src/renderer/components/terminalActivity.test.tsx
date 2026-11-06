import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalInfo } from '@nekko-agent/shared';
import { terminalPresentation, terminalPrUrl } from './terminalActivity.js';
import { TerminalContext } from './TerminalContext.js';
vi.mock('./TerminalViewersBadge.js', () => ({ TerminalViewersBadge: () => null }));
const terminal: TerminalInfo = { id: 't', title: 'Shell', cwd: '/project', shell: '/bin/zsh', running: true, createdAt: 1 };

describe('terminal display metadata', () => {
  it('does not infer work from an open shell or success from an unknown exit', () => {
    expect(terminalPresentation(terminal).status).toBe('Shell open');
    expect(terminalPresentation({ ...terminal, running: false }).status).toBe('Exited');
  });
  it('prefers reported titles and explicit signals; shell exit wins over stale activity', () => {
    const t = { ...terminal, activity: { title: 'Fix login', state: 'attention' as const, detail: 'Permission needed' } };
    expect(terminalPresentation(t)).toMatchObject({ title: 'Fix login', status: 'Needs attention' });
    expect(terminalPresentation({ ...t, running: false, exitCode: 2 }).status).toBe('Exited · code 2');
    expect(terminalPresentation({ ...terminal, activity: { state: 'idle', lastExitCode: 1 } }).status).toBe('Command failed · exit 1');
  });
  it('only offers exact GitHub PR links', () => {
    for (const url of ['javascript:alert(1)', 'https://github.com.evil/a/b/pull/1', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/1?token=secret']) {
      expect(terminalPrUrl({ ...terminal, activity: { pullRequestUrl: url } })).toBeNull();
    }
    expect(terminalPrUrl({ ...terminal, activity: { pullRequestUrl: 'https://github.com/a/b/pull/12' } })).toBe('https://github.com/a/b/pull/12');
  });
  it('escapes untrusted text and labels PR links as observed until fetched', () => {
    const html = renderToStaticMarkup(<TerminalContext terminal={{ ...terminal, activity: { title: '<img src=x>', pullRequestUrl: 'https://github.com/a/b/pull/12' } }} />);
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('Observed link');
    expect(html).toContain('Refresh pull request status');
    expect(html).not.toContain('checks passing');
  });
});

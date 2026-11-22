import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { __setAgentWatches } from '../agentWatches.js';
import { ActiveWatchChips } from './ActiveWatchChips.js';
import { closeWallAgent } from './CommandWall.js';

const watch = { id: 'live', kind: 'timer' as const, status: 'active' as const, deadlineAt: Date.now() + 60000, nextPollAt: 0, pending: false, failures: 0 };
describe('live composer watchers', () => {
  it('shows a live expandable cancellable timer without any tool transcript', () => {
    __setAgentWatches('chips', [watch]);
    const html = renderToStaticMarkup(<ActiveWatchChips sessionId="chips" />);
    expect(html).toContain('data-active-watch-chips');
    expect(html).toContain('<details');
    expect(html).toContain('Timer watcher');
    expect(html).toContain('Cancel watcher');
    expect(html).toContain('left');
  });
  it('names a clip and shows how far it got, with no countdown', () => {
    __setAgentWatches('clip-chips', [{ ...watch, id: 'clip', kind: 'clip' as const, clipStage: 'step:3/20' }]);
    const html = renderToStaticMarkup(<ActiveWatchChips sessionId="clip-chips" />);
    expect(html).toContain('Making a clip');
    expect(html).toContain('step 3 of 20');
    expect(html).toContain('in progress');
    expect(html).toContain('Cancel clip');
    expect(html).not.toContain('left');
    __setAgentWatches('clip-wait', [{ ...watch, id: 'clip', kind: 'clip' as const, clipStage: 'waiting' }]);
    expect(renderToStaticMarkup(<ActiveWatchChips sessionId="clip-wait" />)).toContain('waiting for another picture or clip');
    __setAgentWatches('clip-done', [{ ...watch, id: 'clip', kind: 'clip' as const, pending: true }]);
    const done = renderToStaticMarkup(<ActiveWatchChips sessionId="clip-done" />);
    expect(done).toContain('finished · waiting for the chat');
    expect(done).not.toContain('data-watch-progress');
  });
  it('does not present completed watches as active', () => {
    __setAgentWatches('done-chips', [{ ...watch, status: 'done' }]);
    expect(renderToStaticMarkup(<ActiveWatchChips sessionId="done-chips" />)).toBe('');
  });
  it('waits for host shutdown before removing a chat window', async () => {
    let finish!: () => void;
    const abort = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    window.nekko = { abortChat: abort } as never;
    const remove = vi.fn();
    const closing = closeWallAgent({ id: 'pane', kind: 'chat', refId: 'chat' }, remove);
    expect(abort).toHaveBeenCalledWith('chat');
    expect(remove).not.toHaveBeenCalled();
    finish(); await closing;
    expect(remove).toHaveBeenCalledOnce();
  });
  it('removes non-chat windows without aborting an agent', async () => {
    const abort = vi.fn(); window.nekko = { abortChat: abort } as never; const remove = vi.fn();
    await closeWallAgent({ id: 'pane', kind: 'file', refId: 'file' }, remove);
    expect(abort).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });
});

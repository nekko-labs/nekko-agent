import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { chatSession, renderChatPane, withProvider } from '../tests/renderChatPane.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('../useGitStatus.js', () => ({ useGitStatus: () => null }));
import { terminalStatus } from './CommandWall.js';

describe('a composer in every wall window (#1317)', () => {
  it('puts + then the model and Mode on the bar, with no footer row and an arrow Send', () => {
    withProvider();
    const html = renderChatPane(chatSession(), { commandCenter: true, surface: 'full' });
    expect(html).toContain('data-wall-composer="true"');
    expect(html).not.toContain('data-resting');
    const bar = html.slice(html.indexOf('class="composer-bar'));
    const plus = bar.indexOf('aria-label="Add a photo, video, file, folder, or skill"');
    const foot = bar.indexOf('data-composer-foot');
    expect(plus).toBeGreaterThan(-1);
    expect(foot).toBeGreaterThan(plus);
    expect(bar.slice(foot)).toContain('aria-haspopup="listbox"');
    expect(bar.slice(foot)).toContain('data-chat-mode-button');
    // Model and folder no longer repeat in a footer under the composer, and no strip sits above the editor.
    expect(html).not.toContain('data-agent-footer-controls');
    expect(html).not.toContain('class="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1"');
    expect(html).toContain('wall-send');
    expect(html).not.toContain('send-avatar');
  });

  it('rests as one row in a window that is not selected, and keeps the Agent tab composer as it was', () => {
    withProvider();
    expect(renderChatPane(chatSession(), { commandCenter: true, surface: 'full', resting: true })).toContain('data-resting="true"');
    const agentTab = renderChatPane(chatSession(), { resting: true });
    expect(agentTab).not.toContain('data-resting');
    expect(agentTab).not.toContain('data-wall-composer');
    expect(agentTab).toContain('send-avatar');
  });

  it('shows a terminal as Nekko: asleep while the shell is open, done or failed once it exits', () => {
    expect(terminalStatus({ running: true })).toBe('idle');
    expect(terminalStatus({ running: false, exitCode: 0 })).toBe('done');
    expect(terminalStatus({ running: false })).toBe('done');
    expect(terminalStatus({ running: false, exitCode: 2 })).toBe('error');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { agentSummary, renderSidebar } from '../tests/renderSidebar.js';
import { AGENT_PANEL_VIEW_KEY } from './agentPanelView.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));
vi.stubGlobal('requestAnimationFrame', () => 0);

beforeEach(() => localStorage.removeItem(AGENT_PANEL_VIEW_KEY));

// Chats synced from another computer belong to folders this one does not have,
// so they file under General. Grouped by activity in manual order, the panel
// used to list General's chats before every project's, and with a group showing
// 20 cards, 25 older synced chats hid the newest chat here (#3355).
describe('Agents panel, grouped by activity', () => {
  it('lists the newest chat first, whichever project it is in', () => {
    const synced = Array.from({ length: 25 }, (_, i) => agentSummary(`old${i}`, {
      workspaceId: 'ws_elsewhere',
      updatedAt: 1_000 + i,
      home: { device: 'gomi', deviceId: 'd1' },
    }));
    const html = renderSidebar({ sessions: [...synced, agentSummary('new', { updatedAt: 9_000 })] });
    const newest = html.indexOf('Chat new');
    expect(newest).toBeGreaterThan(-1);
    expect(newest).toBeLessThan(html.indexOf('Chat old24'));
  });
});

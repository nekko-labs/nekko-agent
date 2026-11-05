import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { agentSummary, renderSidebar } from '../tests/renderSidebar.js';
import { applyEvent } from '../liveRuns.js';
import { reportAgentWorking } from '../workingAgents.js';
import { AGENT_PANEL_VIEW_KEY, STATUS_GROUPS } from './agentPanelView.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));
vi.stubGlobal('requestAnimationFrame', () => 0);

/** The group heading nearest above the chat's card, as the panel renders it on mounting. */
function groupOfCard(): string {
  const html = renderSidebar({ sessions: [agentSummary('s1', { phase: 'verifying' })] });
  const card = html.indexOf('Chat s1');
  expect(card).toBeGreaterThan(-1);
  return STATUS_GROUPS.map((g) => ({ name: g.name, at: html.lastIndexOf(`>${g.name}<`, card) })).sort((a, b) => b.at - a.at)[0].name;
}

beforeEach(() => localStorage.removeItem(AGENT_PANEL_VIEW_KEY));

describe('Agents panel, coming back to a chat', () => {
  it('files a chat still running under its phase', () => {
    reportAgentWorking('s1', true);
    expect(groupOfCard()).toBe('Verifying');
    reportAgentWorking('s1', false);
  });

  // Leaving for Settings unmounts the chat pane and this panel. A reply that ended
  // meanwhile used to come back as still working, until the chat's next reply.
  it.each([
    ['finishes', { type: 'done', sessionId: 's1', messageId: 'm' }],
    ['fails', { type: 'error', sessionId: 's1', message: 'boom' }],
  ] as const)('files a chat in Done when its reply %s with no pane open', (_, end) => {
    reportAgentWorking('s1', true);
    applyEvent({ type: 'text', sessionId: 's1', delta: 'x' });
    applyEvent(end);
    expect(groupOfCard()).toBe('Done');
  });
});

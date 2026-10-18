import './browserGlobals.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { putCachedSession } from '../sessionCache.js';
import { ChatPane } from '../components/ChatPane.js';
import { PaneDensityHint } from '../components/agent-console/useElementWidth.js';

/**
 * Server-renders the real ChatPane for a chat painted from the session cache,
 * the way a warm chat opens. The test file must mock the store with
 * `liveStore` and `useLiveRun` (`useSyncExternalStore` has no server snapshot):
 *
 *   vi.mock('../store.js', (o) => liveStore(o as never));
 *   vi.mock('../liveRuns.js', async (o) => ({ ...(await o<object>()), useLiveRun: () => undefined }));
 *
 * For a pane wide enough for the Agent Monitor, also mock the width hook with
 * `elementWidthMock` from `./paneWidth.js` and set `paneWidth.value`.
 */

let n = 0;
export const PROVIDER = { id: 'p', name: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', enabled: true };

export function chatSession(patch: Partial<Session> = {}): Session {
  return {
    id: `chat-${++n}`,
    title: 'Chat',
    createdAt: 0,
    updatedAt: 0,
    providerId: 'p',
    modelId: 'm',
    messages: [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0 },
      { id: 'a1', role: 'assistant', content: 'hello', createdAt: 0 },
    ],
    ...patch,
  } as Session;
}

/** Puts one usable provider and model in the store, so the composer is not in first-run setup. */
export function withProvider(): void {
  useStore.setState({ providers: [PROVIDER] as never, models: [{ id: 'm', name: 'm', providerId: 'p' }] as never });
}

export function renderChatPane(session: Session, props: Partial<React.ComponentProps<typeof ChatPane>> = {}, compact: boolean | null = null): string {
  putCachedSession(session);
  return renderToStaticMarkup(
    <PaneDensityHint.Provider value={compact}>
      <ChatPane sessionId={session.id} {...props} />
    </PaneDensityHint.Provider>,
  );
}

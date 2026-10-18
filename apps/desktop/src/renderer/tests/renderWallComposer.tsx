import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '@nekko-agent/shared';
import { WallComposer, type WallAgent } from '../components/WallComposer.js';
import type { ComposerDock } from '../commandWall.js';
import { putCachedSession } from '../sessionCache.js';
import { chatSession } from './renderChatPane.js';

/**
 * Server-renders the real wall composer, with the real ChatPane inside it for
 * the selected agent. Same setup as `renderChatPane` (liveStore + useLiveRun
 * mocked in the calling file).
 */
export function renderWallComposer(opts: { agent?: Partial<WallAgent> | null; agents?: number; dock?: Partial<ComposerDock>; resizeHandle?: React.ReactNode } = {}): string {
  const noop = () => {};
  let agent: WallAgent | null = null;
  if (opts.agent !== null) {
    const chat = chatSession({ title: 'Wall agent' });
    putCachedSession(chat);
    agent = { session: { ...chat, messageCount: 2 } as unknown as SessionSummary, n: 1, status: { label: 'Working', tone: 'var(--success)', live: true }, glyph: 'working', ...opts.agent };
  }
  const agents = Array.from({ length: opts.agents ?? (agent ? 1 : 0) }, (_, i) => (i === 0 && agent ? agent : { session: { id: `other-${i}`, title: `Other ${i}` } as SessionSummary, n: i + 1, status: null }));
  return renderToStaticMarkup(
    <WallComposer agent={agent} agents={agents} dock={{ side: 'bottom', align: 'center', ...opts.dock }} resizeHandle={opts.resizeHandle}
      onDock={noop} onWidth={noop} onSelect={noop} onOpen={noop} onFocus={noop} onNewAgent={noop} panelRef={{ current: null }} />,
  );
}

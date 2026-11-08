import { SubagentRoute } from './SubagentRoute.js';
import React from 'react';
import type { SessionSummary } from '@nekko-agent/shared';
import { RobotIcon } from '../icons.js';
import { useStore } from '../store.js';

/**
 * The strip across the top of a sub-agent's chat. It says this chat is a
 * sub-agent, names the chat that spawned it, and opens that chat, so a
 * delegated run never passes for a chat of its own.
 */
export function SubagentBanner({ parentId, onOpenParent, child }: { child?: Pick<SessionSummary, 'providerId' | 'modelId'>; parentId: string; onOpenParent: (id: string) => void }) {
  const parentTitle = useStore((s) => s.sessions?.find((x) => x.id === parentId)?.title);
  const name = parentTitle || 'its parent chat';
  return (
    <div className="subagent-banner flex-wrap" data-subagent-banner role="note" aria-label={`Sub-agent of ${name}`}>
      <RobotIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0 font-semibold">Sub-agent</span>
      <span className="shrink-0 opacity-70">of</span>
      <button type="button" className="subagent-banner-parent" title={`Open ${name}`} onClick={() => onOpenParent(parentId)}>
        <span className="truncate" dir="auto">{name}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 4 4 4-4 4" /></svg>
      </button>
      {child && <SubagentRoute child={child} className="max-w-full" />}
    </div>
  );
}

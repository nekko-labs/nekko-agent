import React, { useEffect, useRef, useState } from 'react';
import type { ChatArtifact } from '../chatArtifacts.js';
import { ChatArtifacts } from './ChatArtifacts.js';
import { createArtifactDiscovery } from './artifactDiscovery.js';

/** Session-keyed by PlanRail so switching chats also resets manual disclosure state. */
export function MonitorArtifacts({ sessionId, artifacts, hydrated }: {
  sessionId: string;
  artifacts: ChatArtifact[];
  hydrated: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [highlighted, setHighlighted] = useState(false);
  const [discovery] = useState(() => createArtifactDiscovery(() => {
    if (details.current) details.current.open = true;
  }, setHighlighted));
  useEffect(() => {
    discovery.update(sessionId, hydrated ? artifacts.map(artifact => artifact.path) : null);
  }, [discovery, sessionId, artifacts, hydrated]);
  useEffect(() => () => discovery.dispose(), [discovery]);

  return <details ref={details} className="group rounded-lg border p-2" style={{
    borderColor: highlighted ? 'var(--accent)' : 'transparent',
    background: highlighted ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
  }}>
    <summary className="cursor-pointer text-xs font-medium text-ink-soft">
      Artifacts <span className="ml-1 tabular-nums">{artifacts.length}</span>
      <span role="status" aria-live="polite" aria-atomic="true" className="ml-2 normal-case tracking-normal text-ink">{highlighted ? 'New artifact' : ''}</span>
    </summary>
    {artifacts.length ? <ChatArtifacts artifacts={artifacts} sessionId={sessionId} /> : <p className="mt-2 text-2xs text-ink-faint">No artifacts yet.</p>}
  </details>;
}

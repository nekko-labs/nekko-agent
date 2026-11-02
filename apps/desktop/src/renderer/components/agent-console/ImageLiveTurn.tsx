import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@nekko-agent/shared';

/**
 * The reply being made in an image chat: a placeholder frame with the stage
 * (loading the model, then generating) and the time so far. An image model
 * streams nothing until the picture exists, so this is all there is to show,
 * and a cold first request that spends most of its time loading says so.
 */
export function ImageLiveTurn({ sessionId, streaming }: { sessionId: string; streaming: boolean }) {
  const [label, setLabel] = useState('Generating the image');
  const [seconds, setSeconds] = useState(0);
  const started = useRef(Date.now());

  useEffect(() => window.nekko.onAgentEvent((e: AgentEvent) => {
    if (e.sessionId === sessionId && e.type === 'image_status') setLabel(e.label);
  }), [sessionId]);
  useEffect(() => {
    if (!streaming) return;
    started.current = Date.now();
    setSeconds(0);
    setLabel('Generating the image');
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [streaming]);

  if (!streaming) return null;
  return (
    <div className="flex items-start gap-3 py-2" role="status" aria-live="polite">
      <div className="grid h-40 w-40 shrink-0 animate-pulse place-items-center rounded-xl border border-line bg-surface-2 text-2xs text-ink-faint">
        {seconds}s
      </div>
      <p className="pt-1 text-xs text-ink-soft">{label}…</p>
    </div>
  );
}

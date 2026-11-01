import React, { useRef } from 'react';
import { PeekNekkoArt, useComposerGaze } from './GreetingNekko.js';

/**
 * The per-chat Nekko. Peeks over the left end of the agent window's composer,
 * paws hanging over its top edge, the way the new-chat greeting does; the left
 * side leaves the centred plan sheet room beside him. His eyes follow the
 * composer caret as you type or move the selection, and drift to the
 * composer's centre when there is no caret. One `settings.mascotEnabled`
 * toggle hides every chat's mascot at once.
 *
 * Rendered inside `.composer-section`, which is where the gaze hook looks for
 * the editor.
 */
export function ChatMascot({
  enabled,
  working,
  wizardHat,
}: {
  enabled: boolean;
  working: boolean;
  wizardHat: boolean;
}) {
  const faceRef = useRef<SVGSVGElement>(null);
  const look = useComposerGaze(faceRef, { restOnComposer: true, deps: [enabled] });
  if (!enabled) return null;
  return (
    <span className="chat-mascot" data-chat-mascot={working ? 'working' : 'idle'} aria-hidden="true">
      <PeekNekkoArt ref={faceRef} className="chat-mascot-art" look={look} wizardHat={wizardHat} />
    </span>
  );
}

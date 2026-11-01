import React, { useEffect, useRef, useState } from 'react';
import { PeekNekkoArt, useComposerGaze } from './GreetingNekko.js';

/** Paws come up on their own now and then: every 25-70s, for 2.5s. */
const PAWS_PEEK_MIN_MS = 25_000;
const PAWS_PEEK_SPREAD_MS = 45_000;
const PAWS_PEEK_HOLD_MS = 2_500;

/**
 * The per-chat Nekko. Peeks over the left end of the agent window's composer
 * the way the new-chat greeting does; the left side leaves the centred plan
 * sheet room beside him. By default only his face shows over the edge: his
 * paws come up while the composer has focus, and on a random occasion. His
 * eyes follow the composer caret as you type or move the selection, and drift
 * to the composer's centre when there is no caret. One `settings.mascotEnabled`
 * toggle hides every chat's mascot at once.
 *
 * Rendered inside `.composer-section`, which is where the gaze hook looks for
 * the editor and where focus is watched.
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
  const [focused, setFocused] = useState(false);
  const [peeking, setPeeking] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const composer = faceRef.current?.closest('.composer-section');
    if (!composer) return;
    const sync = () => setFocused(composer.contains(document.activeElement));
    // On focusout the next element isn't active yet; read it once it is.
    const blurred = () => queueMicrotask(sync);
    sync();
    composer.addEventListener('focusin', sync);
    composer.addEventListener('focusout', blurred);
    return () => {
      composer.removeEventListener('focusin', sync);
      composer.removeEventListener('focusout', blurred);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        // A hidden window gets no show; just wait for the next occasion.
        if (!document.hidden) setPeeking(true);
        timer = setTimeout(() => { setPeeking(false); schedule(); }, PAWS_PEEK_HOLD_MS);
      }, PAWS_PEEK_MIN_MS + Math.random() * PAWS_PEEK_SPREAD_MS);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [enabled]);

  if (!enabled) return null;
  return (
    <span className="chat-mascot" data-chat-mascot={working ? 'working' : 'idle'} aria-hidden="true">
      <PeekNekkoArt ref={faceRef} className="chat-mascot-art" look={look} wizardHat={wizardHat} paws={focused || peeking} />
    </span>
  );
}

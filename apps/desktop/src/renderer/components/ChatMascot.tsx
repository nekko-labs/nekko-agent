import React, { useEffect, useRef, useState } from 'react';
import { PeekNekkoArt, useComposerGaze, type PeekFace } from './GreetingNekko.js';

/** Paws come up on their own now and then: every 25-70s, for 2.5s. */
const PAWS_PEEK_MIN_MS = 25_000;
const PAWS_PEEK_SPREAD_MS = 45_000;
const PAWS_PEEK_HOLD_MS = 2_500;
/** How long he keeps smiling once he is back from ducking: the pop takes 260ms of it. */
const BACK_SMILE_MS = 1_400;

/**
 * Where he is while an approval comes and goes. `ducking` is the startled look
 * and the slide down behind the composer's edge; `away` is already down (he
 * arrived with the approval waiting, so there is nothing to animate);
 * `popping` is the quick hop back up with a smile.
 */
export type MascotPose = 'here' | 'ducking' | 'away' | 'popping';
type Pose = MascotPose;

/** The pose once an approval starts (`away`) or stops waiting. */
export function nextMascotPose(pose: MascotPose, away: boolean): MascotPose {
  if (away) return pose === 'away' ? 'away' : 'ducking';
  return pose === 'ducking' || pose === 'away' ? 'popping' : pose;
}
const FACE: Record<Pose, PeekFace | undefined> = { here: undefined, ducking: 'alert', away: 'alert', popping: 'smile' };

/**
 * The per-chat Nekko. Peeks over the left end of the agent window's composer
 * the way the new-chat greeting does; the left side leaves the centred plan
 * sheet room beside him. By default only his face shows over the edge: his
 * paws come up while the composer has focus, and on a random occasion. His
 * eyes follow the composer caret as you type or move the selection, and drift
 * to the composer's centre when there is no caret. One `settings.mascotEnabled`
 * toggle hides every chat's mascot at once.
 *
 * While `away` (an approval waits above the composer) he looks alarmed and
 * ducks down behind the composer's edge, clear of the approval bar's buttons.
 * Once it is answered he pops straight back up, smiling, then goes back to
 * watching the caret.
 *
 * Rendered inside `.composer-section`, which is where the gaze hook looks for
 * the editor and where focus is watched.
 */
export function ChatMascot({
  enabled,
  working,
  wizardHat,
  away = false,
}: {
  enabled: boolean;
  working: boolean;
  wizardHat: boolean;
  away?: boolean;
}) {
  const faceRef = useRef<SVGSVGElement>(null);
  const look = useComposerGaze(faceRef, { restOnComposer: true, deps: [enabled] });
  const [focused, setFocused] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [pose, setPose] = useState<Pose>(away ? 'away' : 'here');

  // Adjusted during render, so the alarmed face and the duck start on the
  // same frame the approval bar appears.
  const [wasAway, setWasAway] = useState(away);
  if (away !== wasAway) {
    setWasAway(away);
    setPose(nextMascotPose(pose, away));
  }

  useEffect(() => {
    if (pose !== 'popping') return;
    const timer = setTimeout(() => setPose('here'), BACK_SMILE_MS);
    return () => clearTimeout(timer);
  }, [pose]);

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
  const down = pose === 'ducking' || pose === 'away';
  return (
    <span className="chat-mascot" data-chat-mascot={working ? 'working' : 'idle'} data-chat-mascot-pose={pose === 'here' ? undefined : pose} aria-hidden="true">
      <PeekNekkoArt ref={faceRef} className="chat-mascot-art" look={look} face={FACE[pose]} wizardHat={wizardHat} paws={!down && (focused || peeking || pose === 'popping')} />
    </span>
  );
}

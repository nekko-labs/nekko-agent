import React, { useEffect, useRef, useState } from 'react';
import { NekkoAvatar } from './Mascot.js';
import { greetingGaze } from './GreetingNekko.js';

/**
 * The per-chat Nekko. Sits inside each agent window's top-right (right edge at
 * ~80% from the left of the pane) and watches the composer caret: when the user
 * types or the selection moves, the pupils translate toward the caret inside
 * the face. One `settings.mascotEnabled` toggle hides every chat's mascot at
 * once; the global corner mascot is retired now that each chat has its own.
 *
 * The caret-reading loop is lifted from `GreetingNekko`: a bounded, animation-
 * frame-throttled read of `document.getSelection()` scoped to the chat pane
 * this mascot lives in.
 */
export function ChatMascot({
  enabled,
  working,
  wizardHat,
  paneRef,
}: {
  enabled: boolean;
  working: boolean;
  wizardHat: boolean;
  /** The pane that owns this mascot: we only read a caret inside this subtree. */
  paneRef: React.RefObject<HTMLElement | null>;
}) {
  const faceRef = useRef<SVGSVGElement>(null);
  const [pupil, setPupil] = useState({ x: 0, y: 1 });

  useEffect(() => {
    if (!enabled) return;
    const face = faceRef.current;
    const pane = paneRef.current;
    if (!face || !pane) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const selection = document.getSelection();
        const editor = pane.querySelector<HTMLElement>('[contenteditable="true"], textarea');
        if (!editor) return;
        let caret: DOMRect | null = null;
        if (selection?.focusNode && editor.contains(selection.focusNode) && selection.rangeCount) {
          const range = selection.getRangeAt(0).cloneRange();
          range.setStart(selection.focusNode, selection.focusOffset);
          range.collapse(true);
          caret = range.getClientRects()[0] ?? null;
        }
        // At rest (no live caret) the pupils drift to the composer centre, so
        // the eyes still look at the thing the typist is about to touch rather
        // than freezing on a stale glance.
        const target = caret ?? editor.getBoundingClientRect();
        const faceRect = face.getBoundingClientRect();
        setPupil(greetingGaze(
          target.left + target.width / 2 - (faceRect.left + faceRect.width / 2),
          target.top + target.height / 2 - (faceRect.top + faceRect.height / 2),
        ));
      });
    };
    update();
    document.addEventListener('selectionchange', update);
    pane.addEventListener('input', update);
    pane.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', update);
      pane.removeEventListener('input', update);
      pane.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [enabled, paneRef]);

  if (!enabled) return null;
  // right-[20%]: the mascot's right edge sits at 20% from the pane's right edge,
  // placing the whole cat about 80% along the top as Philip asked. z-10 so it
  // reads over the transcript tint but under modals and toasts.
  return (
    <span
      className="pointer-events-none absolute right-[20%] top-2 z-10 flex select-none items-start"
      data-chat-mascot={working ? 'working' : 'idle'}
      aria-hidden="true"
    >
      <NekkoAvatar
        ref={faceRef}
        size={56}
        stationary={working}
        quiet={!working}
        wizardHat={wizardHat}
        pupilOffset={pupil}
      />
    </span>
  );
}

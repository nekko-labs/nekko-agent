import { useEffect, useRef } from 'react';
import type React from 'react';
import type { MarkdownEditorElement } from './agent-console/MarkdownEditor.js';
import { usePaneVisible } from '../paneVisibility.js';
import { afterPaint } from '../afterPaint.js';

/**
 * Focus the composer when a chat opens so you can start typing straight away,
 * caret after any restored draft. Once per chat, and again whenever a pane
 * kept mounted behind the scenes is shown, so switching back to a chat lands
 * in its composer as it always did. Never steals focus from something else
 * you're already typing in. `ready` is a dependency because the editor is
 * disabled until a usable provider has loaded (which need not change provider count).
 *
 * Its own component so the pane showing and hiding re-renders this, not the
 * chat; and done after the frame, because focus forces a layout, and paying for
 * it inside the switch would hold back the frame that shows the chat.
 */
export function ComposerFocus({ target, sessionId, ready }: { target: React.RefObject<MarkdownEditorElement | null>; sessionId: string; ready: boolean }) {
  const visible = usePaneVisible();
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) {
      focusedFor.current = null;
      return;
    }
    if (!ready || focusedFor.current === sessionId) return;
    return afterPaint(() => {
      const el = target.current;
      if (!el || !el.isContentEditable) return;
      const active = document.activeElement;
      // A composer in a pane that was just hidden may still hold focus for a
      // moment; it is not someone typing.
      const typingElsewhere =
        active instanceof HTMLElement &&
        active !== el &&
        active.checkVisibility?.() !== false &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      // Consume the opening attempt even when the user is already typing.
      focusedFor.current = sessionId;
      if (typingElsewhere) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [visible, sessionId, ready, target]);
  return null;
}

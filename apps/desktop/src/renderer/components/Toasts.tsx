import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';

const COLOR = { info: 'var(--info)', error: 'var(--danger)', success: 'var(--success)' };

/** Bottom-left transient notifications (errors, confirmations). */
export function Toasts() {
  const { toasts, dismissToast } = useStore(useShallow((s) => ({ toasts: s.toasts, dismissToast: s.dismissToast })));
  if (toasts.length === 0) return null;
  return (
    // On a phone the stack spans the screen above the tab bar; from sm up it is
    // a 20rem column in the corner.
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-[calc(4rem+env(safe-area-inset-bottom,0px)+8px)] left-4 right-4 z-50 flex flex-col gap-2 sm:right-auto sm:w-80 md:bottom-5 md:left-5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="fade-in card pointer-events-auto flex items-start gap-3 p-3 shadow-(--shadow-float)"
          onClick={() => dismissToast(t.id)}
        >
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: COLOR[t.kind] }} />
          <span className="min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere]">{t.message}</span>
        </div>
      ))}
    </div>
  );
}

import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';

const COLOR = { info: 'var(--info)', error: 'var(--danger)', success: 'var(--success)' };

/**
 * Bottom-left notifications (errors, confirmations). At most a few show at
 * once (the store pushes older ones out); infos time out, errors stay until
 * clicked or closed. A dismissed toast fades down briefly before it goes.
 */
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
          data-toast={t.kind}
          data-leaving={t.leaving || undefined}
          className="toast-item card pointer-events-auto flex items-start gap-3 p-3 shadow-(--shadow-float)"
          onClick={() => dismissToast(t.id)}
        >
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: COLOR[t.kind] }} />
          <span className="min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere]">{t.message}</span>
          {t.kind === 'error' && (
            <button
              type="button"
              aria-label="Dismiss"
              className="-m-1 shrink-0 rounded p-1 text-ink-faint hover:text-ink"
              onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

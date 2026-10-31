import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';

const COLOR = { info: 'var(--info)', error: 'var(--danger)', success: 'var(--success)' };

/** Bottom-left transient notifications (errors, confirmations). */
export function Toasts() {
  const { toasts, dismissToast } = useStore(useShallow((s) => ({ toasts: s.toasts, dismissToast: s.dismissToast })));
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 left-5 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="fade-in card pointer-events-auto flex items-start gap-3 p-3 shadow-(--shadow-float)"
          onClick={() => dismissToast(t.id)}
        >
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: COLOR[t.kind] }} />
          <span className="text-sm leading-snug">{t.message}</span>
        </div>
      ))}
    </div>
  );
}

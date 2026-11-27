import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/** How many dialogs are open — only the outermost one hides the app root. */
let openDialogs = 0;

/**
 * Dialog behaviour for any overlay: Escape closes, Tab cycles inside the
 * dialog, focus moves in on open and back to the trigger on close, and the app
 * behind is hidden from assistive tech while it is up.
 *
 * Returns the ref to put on the dialog element.
 */
export function useDialog<T extends HTMLElement>({
  onClose, closeOnEscape = true, initialFocus,
}: {
  onClose: () => void;
  closeOnEscape?: boolean;
  /** Element to focus on open; defaults to the first focusable child. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const root = ref.current;
    const trigger = document.activeElement as HTMLElement | null;
    const appRoot = document.getElementById('root');
    openDialogs += 1;
    if (openDialogs === 1) appRoot?.setAttribute('aria-hidden', 'true');

    const target = initialFocus?.current ?? (root ? focusable(root)[0] : null) ?? root;
    // Let the overlay paint before pulling focus, so autofocused inputs and
    // freshly mounted children are already in the DOM.
    const raf = requestAnimationFrame(() => target?.focus());

    const onKeyDown = (e: KeyboardEvent) => {
      if (!root) return;
      if (e.key === 'Escape' && closeOnEscape) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      openDialogs = Math.max(0, openDialogs - 1);
      if (openDialogs === 0) appRoot?.removeAttribute('aria-hidden');
      trigger?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ref;
}

/**
 * A modal overlay: a labelled `role="dialog"` surface over a click-to-dismiss
 * scrim, with the focus management above. `title` is the accessible name, used
 * when the design has no visible heading of its own (otherwise pass
 * `labelledBy` with that heading's id).
 *
 * Rendered in a portal on `document.body` so the app root can be hidden from
 * assistive tech while the dialog is up without hiding the dialog with it.
 */
export function Modal({
  title,
  description,
  onClose,
  closeOnEscape = true,
  closeOnScrimClick = true,
  initialFocus,
  align = 'center',
  scrim = 'rgba(0,0,0,0.4)',
  zIndex = 50,
  overlayClassName = '',
  className = '',
  labelledBy,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  closeOnEscape?: boolean;
  closeOnScrimClick?: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
  align?: 'center' | 'top' | 'stretch';
  scrim?: string;
  zIndex?: number;
  overlayClassName?: string;
  className?: string;
  /** Id of an element inside `children` that already names the dialog. */
  labelledBy?: string;
  children: React.ReactNode;
}) {
  const dialogRef = useDialog<HTMLDivElement>({ onClose, closeOnEscape, initialFocus });
  const autoId = useId();
  const titleId = labelledBy ?? `${autoId}-title`;
  const descId = description ? `${autoId}-desc` : undefined;

  const onScrim = useCallback(() => { if (closeOnScrimClick) onClose(); }, [closeOnScrimClick, onClose]);

  const position =
    align === 'top' ? 'flex items-start justify-center pt-[12vh]'
      : align === 'stretch' ? 'flex flex-col'
        : 'flex items-center justify-center';

  // no-drag: an overlay over the title bar's drag strip otherwise loses its clicks there; z-index doesn't count.
  return createPortal(
    <div className={`fixed inset-0 [-webkit-app-region:no-drag] ${position} ${overlayClassName}`} style={{ background: scrim, zIndex }} onClick={onScrim}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className={`outline-hidden ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {!labelledBy && <h2 id={titleId} className="sr-only">{title}</h2>}
        {description && <p id={descId} className="sr-only">{description}</p>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

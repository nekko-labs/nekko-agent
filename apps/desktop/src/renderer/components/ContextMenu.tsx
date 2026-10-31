import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  return createPortal(<div ref={ref} role="menu" tabIndex={-1} className="context-menu card fixed z-[100] max-h-[80vh] w-64 overflow-auto p-2 shadow-(--shadow-float) outline-hidden" style={{ left: Math.max(8, Math.min(x, window.innerWidth - 272)), top: Math.max(8, Math.min(y, window.innerHeight - 360)) }} onContextMenu={(e) => e.preventDefault()}>{children}</div>, document.body);
}

export function ContextAction({ children, onClick, disabled = false }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button role="menuitem" disabled={disabled} className="block w-full rounded-lg px-2.5 py-2 text-left text-xs context-action disabled:cursor-not-allowed disabled:opacity-40" onClick={onClick}>{children}</button>;
}

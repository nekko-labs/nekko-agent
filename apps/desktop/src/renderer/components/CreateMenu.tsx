import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NekkoAvatar } from './Mascot.js';
import { PhotoIcon, PlusIcon, TerminalIcon } from '../icons.js';
import { SHORTCUTS } from '../shortcuts.js';

export type CreateKind = 'chat' | 'image' | 'terminal';
export function CreateMenuRows({ onCreate }: { onCreate: (kind: CreateKind) => void }) {
  return <>{([
    ['chat', 'Agent', <NekkoAvatar size={16} stationary eyes={false} />, SHORTCUTS.newAgent],
    ['image', 'Create or Edit Photos and Videos', <PhotoIcon className="h-4 w-4" />, SHORTCUTS.newMedia],
    ['terminal', 'Terminal', <TerminalIcon className="h-4 w-4" />, SHORTCUTS.newTerminal],
  ] as const).map(([kind, label, icon, shortcut]) => <button key={kind} type="button" className="create-row flex w-full items-center gap-2 rounded-md px-2 py-1 text-left" onClick={() => onCreate(kind)}>
    <span className="create-tile">{icon}</span>
    <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug">{label}</span>
    <kbd className="kbd shrink-0">{shortcut.label}</kbd>
  </button>)}</>;
}

/** Hover menu with a grace period to cross the portal gap, also operable by keyboard. */
export function CreateMenu({ onCreate, anchorRef }: { onCreate: (kind: CreateKind) => void; anchorRef?: React.RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ownAnchor = useRef<HTMLButtonElement>(null);
  const anchor = anchorRef ?? ownAnchor;
  const pop = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => clearTimeout(timer.current);
  const close = () => { cancel(); setOpen(false); };
  const show = () => { cancel(); setOpen(true); };
  const leave = () => { cancel(); timer.current = setTimeout(close, 180); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = pop.current?.getBoundingClientRect();
      if (a && p) setPos({ left: Math.max(8, Math.min(a.right - p.width, window.innerWidth - p.width - 8)), top: Math.max(8, Math.min(a.bottom + 6, window.innerHeight - p.height - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!anchor.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); anchor.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  return <>
    <button ref={anchor} type="button" className="btn btn-ghost agent-panel-plus px-1.5 py-1" aria-label="Create new" aria-haspopup="dialog" aria-expanded={open} data-wall-create-toggle onMouseEnter={show} onMouseLeave={leave} onClick={show} onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); requestAnimationFrame(() => pop.current?.querySelector('button')?.focus()); } }}><PlusIcon className="h-[22px] w-[22px]" /></button>
    {open && createPortal(<div ref={pop} role="dialog" aria-label="Create new" data-wall-create-menu className="create-menu card fixed z-[1000] w-max p-1 shadow-lg" style={pos} onMouseEnter={cancel} onMouseLeave={leave} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) close(); }}><CreateMenuRows onCreate={kind => { close(); onCreate(kind); }} /></div>, document.body)}
  </>;
}

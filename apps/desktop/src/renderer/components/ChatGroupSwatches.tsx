import React from 'react';
import { HUE_CONIC_GRADIENT } from './ColorWheel.js';
import { CHAT_GROUP_COLORS, chatGroupColorValue, normalizeHexColor, type ChatGroupColor } from '../views/chatGroups.js';

const SWATCH = 'h-4 w-4 shrink-0 rounded-md outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent';
const SELECTED = 'outline outline-2 outline-ink-soft';

/** The swatch an arrow key moves to from `from`, wrapping round the `total` in the row. */
export function nextSwatchIndex(from: number, step: 1 | -1, total: number): number {
  return total <= 0 ? 0 : (from + step + total) % total;
}

/**
 * The colours a chat group can have, in one row: the six presets, then the custom
 * colours the user has used (each with a small x on hover or focus, or Delete),
 * then a rainbow tile that opens the wheel. Tab steps through every colour in
 * turn (each swatch is its own tab stop, by request, rather than the usual one
 * stop per radio group), then the rainbow tile; arrow keys also move and pick.
 * Space or Enter picks the focused colour. The rainbow is a disclosure button.
 */
export function ChatGroupSwatches({ value, saved = [], open = false, controls, onPreset, onCustom, onRemove, onToggleOpen, label = 'Group colour' }: {
  /** The colour picked; null when none is yet (no swatch is selected). */
  value: ChatGroupColor | null;
  /** Custom colours to offer after the presets, newest first. */
  saved?: ReadonlyArray<string>;
  /** Whether the wheel below is open, which the rainbow tile shows. */
  open?: boolean;
  /** The id of the wheel's panel, for the rainbow tile's aria-controls. */
  controls?: string;
  onPreset: (index: number) => void;
  onCustom?: (hex: string) => void;
  /** Forget a saved colour; groups already using it keep it. */
  onRemove?: (hex: string) => void;
  onToggleOpen?: () => void;
  label?: string;
}) {
  const current = typeof value === 'string' ? normalizeHexColor(value) : null;
  // The colour in use is always shown, saved or not.
  const customs = current && !saved.includes(current) ? [current, ...saved] : [...saved];

  const choose = (target: number, group: HTMLElement | null) => {
    const swatches = [...(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    swatches[target]?.focus();
    swatches[target]?.click();
  };
  const move = (e: React.KeyboardEvent<HTMLElement>, from: number, hex?: string) => {
    if (hex && (e.key === 'Delete' || e.key === 'Backspace') && saved.includes(hex)) { e.preventDefault(); e.stopPropagation(); onRemove?.(hex); return; }
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault(); e.stopPropagation();
    const group = e.currentTarget.closest<HTMLElement>('[role="radiogroup"]');
    const total = group?.querySelectorAll('[role="radio"]').length ?? 0;
    if (total) choose(nextSwatchIndex(from, step as 1 | -1, total), group);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 p-1" data-chat-group-swatches>
      <div role="radiogroup" aria-label={label} className="contents">
        {CHAT_GROUP_COLORS.map((c, i) => (
          <button
            key={c.token}
            type="button"
            role="radio"
            aria-checked={value === i}
            aria-label={c.label}
            title={c.label}
            tabIndex={0}
            className={`${SWATCH} ${value === i ? SELECTED : ''}`}
            style={{ background: chatGroupColorValue(i) }}
            onClick={() => onPreset(i)}
            onKeyDown={(e) => move(e, i)}
          />
        ))}
        {customs.map((hex, j) => (
          <span key={hex} className="group relative inline-flex" data-chat-group-saved={hex}>
            <button
              type="button"
              role="radio"
              aria-checked={current === hex}
              aria-label={`Custom colour ${hex}`}
              title={hex}
              tabIndex={0}
              className={`${SWATCH} ${current === hex ? SELECTED : ''}`}
              style={{ background: hex }}
              onClick={() => onCustom?.(hex)}
              onKeyDown={(e) => move(e, CHAT_GROUP_COLORS.length + j, hex)}
            />
            {saved.includes(hex) && onRemove && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Remove custom colour ${hex}`}
                className="absolute -right-1 -top-1 grid h-3 w-3 place-items-center rounded-full bg-surface text-ink-soft opacity-0 shadow-(--shadow-float) transition-opacity duration-(--dur-fast) hover:text-ink focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                onClick={() => onRemove(hex)}
              >
                <svg aria-hidden viewBox="0 0 24 24" className="h-2 w-2" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            )}
          </span>
        ))}
      </div>
      {onToggleOpen && (
        <button
          type="button"
          aria-label="Custom colour…"
          title="Custom colour…"
          aria-expanded={open}
          aria-controls={controls}
          data-chat-group-custom
          className={`${SWATCH} ${open ? SELECTED : ''}`}
          style={{ background: HUE_CONIC_GRADIENT }}
          onClick={onToggleOpen}
        />
      )}
    </div>
  );
}

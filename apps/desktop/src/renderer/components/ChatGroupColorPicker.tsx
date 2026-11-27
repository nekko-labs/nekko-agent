import React, { useEffect, useId, useRef, useState } from 'react';
import './chatGroupColorPicker.css';
import { ColorWheel } from './ColorWheel.js';
import { ChatGroupSwatches } from './ChatGroupSwatches.js';
import {
  CHAT_GROUP_COLORS, normalizeHexColor, readSavedCustomColors, removeSavedCustomColor, rememberCustomColor, saveSavedCustomColors,
  type ChatGroupColor,
} from '../views/chatGroups.js';

/** The `#rrggbb` a colour shows as, for the wheel to start from (a palette token is read off the page). */
function hexOf(color: ChatGroupColor | null): string {
  if (color === null) return '#808080';
  if (typeof color === 'string') return normalizeHexColor(color) ?? '#808080';
  return presetHexes()[color] ?? '#808080';
}

/** What the six presets are as hex on this page, so a custom colour that matches one is not saved twice. */
export function presetHexes(): string[] {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return CHAT_GROUP_COLORS.map(() => '#808080');
  const style = getComputedStyle(document.documentElement);
  return CHAT_GROUP_COLORS.map((c) => normalizeHexColor(style.getPropertyValue(c.token)) ?? '#808080');
}

/** Keep a custom colour as a swatch once it has been chosen for a group (presets and bad values are skipped). */
export function rememberChosenColor(color: ChatGroupColor | null): void {
  if (typeof color === 'string') rememberCustomColor(color, presetHexes());
}

/**
 * Pick a chat group's colour. Collapsed it is one row: the six presets, the custom
 * colours chosen before, and a rainbow tile. The tile opens the theme settings'
 * wheel with a vertical brightness bar beside it, and a hex field (no preview dot: the swatch row shows the pick)
 * under it. A preset is kept as its palette index, anything else as `#rrggbb`.
 *
 * Dragging and typing never add to the saved swatches. A custom colour joins them
 * once it is chosen for a group: when the group is created (the form remembers
 * it), or, with `rememberOnClose`, when the picker closes on it (a group's Colour menu).
 */
export function ChatGroupColorPicker({ value, onChange, defaultOpen = false, rememberOnClose = false, action }: {
  /** Null while none is picked: no swatch is selected. */ value: ChatGroupColor | null; onChange: (color: ChatGroupColor) => void;
  /** Start with the wheel open (it starts closed, even on a custom colour). */ defaultOpen?: boolean;
  /** Keep the colour showing when the picker closes as a swatch. */ rememberOnClose?: boolean;
  /** A button to finish with (Create group): beside the hex field when the wheel is open, on its own row at the end when not. */ action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [saved, setSaved] = useState<string[]>(readSavedCustomColors);
  const panel = useId();
  const hex = hexOf(value);
  const [draft, setDraft] = useState(hex);
  useEffect(() => setDraft(hex), [hex]);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => () => { if (rememberOnClose) rememberChosenColor(latest.current); }, [rememberOnClose]);

  return (
    <div className="flex max-w-full flex-col gap-2" data-chat-group-color-picker>
      <ChatGroupSwatches
        value={value}
        saved={saved}
        open={open}
        controls={panel}
        onPreset={(i) => { onChange(i); setOpen(false); }}
        onCustom={(color) => onChange(color)}
        onRemove={(color) => { const next = removeSavedCustomColor(saved, color); saveSavedCustomColors(next); setSaved(next); }}
        onToggleOpen={() => setOpen((o) => !o)}
      />
      {open && (
        <div id={panel} className="chat-group-color-open flex flex-col gap-2 px-1" data-chat-group-color-open>
          <ColorWheel value={hex} onChange={(next) => onChange(next)} size={120} label="Group colour wheel" sliderOrientation="vertical" />
          <div className="flex items-center gap-2">
            <input
              className="quiet-field w-24 py-1 text-center font-mono text-xs"
              aria-label="Group colour hex"
              value={draft}
              spellCheck={false}
              maxLength={7}
              onChange={(e) => {
                setDraft(e.target.value);
                // Hold a half-typed value; only a complete hex is kept, the rest is ignored.
                const next = normalizeHexColor(e.target.value);
                if (next && /^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) onChange(next);
              }}
            />
            {action && <div className="ms-auto shrink-0" data-chat-group-color-action>{action}</div>}
          </div>
        </div>
      )}
      {/* Closed, there is no hex row: the action takes its own row at the end. */}
      {!open && action && <div className="flex justify-end" data-chat-group-color-action>{action}</div>}
    </div>
  );
}

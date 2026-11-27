import React, { useState } from 'react';
import { ChatGroupColorPicker, rememberChosenColor } from './ChatGroupColorPicker.js';
import { MAX_CHAT_GROUP_LENGTH, normalizeChatGroup, type ChatGroupColor } from '../views/chatGroups.js';

/**
 * Making or editing a chat group: a name that is optional and a colour that is
 * not. Making one, no colour is selected to begin with and nothing falls back to
 * a default one: Create stays disabled until a colour is picked. Editing one
 * (`initialColor`, `submitLabel` "Save"), the current colour is selected, so
 * Save is enabled at once. Enter in the name field submits (once there is a
 * colour). There is no Cancel button: Escape cancels (staying inside any menu
 * around it) and clicking outside closes the menu. A custom colour joins the
 * saved swatches when the form is submitted.
 */
export function NewChatGroupForm({ initialName = '', initialColor = null, submitLabel = 'Create group', onSubmit, onCancel }: {
  initialName?: string;
  /** The colour selected to begin with (editing a group); none when making one. */
  initialColor?: ChatGroupColor | null;
  /** The submit button's text. */
  submitLabel?: string;
  /** The name (null when left empty) and the colour picked. */
  onSubmit: (name: string | null, color: ChatGroupColor) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<ChatGroupColor | null>(initialColor);
  return (
    <form
      className="flex flex-col gap-2"
      data-new-chat-group-form
      onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); if (color !== null) { rememberChosenColor(color); onSubmit(normalizeChatGroup(name), color); } }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}
    >
      <input
        autoFocus
        className="quiet-field w-full text-xs"
        placeholder="Name (optional)"
        aria-label="Group name (optional)"
        maxLength={MAX_CHAT_GROUP_LENGTH}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {/* No Cancel: clicking outside or Escape leaves without saving. The button sits
          beside the hex field when the wheel is open, so it takes no row of its own. */}
      <ChatGroupColorPicker
        value={color}
        onChange={setColor}
        action={<button type="submit" className="btn btn-primary whitespace-nowrap px-2 py-1 text-2xs" disabled={color === null} title={color === null ? 'Pick a colour first' : undefined} data-new-chat-group-create>{submitLabel}</button>}
      />
    </form>
  );
}

import React, { useId, useRef, useState } from 'react';
import './chatGroupTagPicker.css';
import { NewChatGroupForm } from './NewChatGroupForm.js';
import { CheckIcon } from '../icons.js';
import { MAX_CHAT_TAG_LENGTH, chatTagState, movePickerIndex, normalizeChatTag, pickerOptions, pickerSections, type PickerOption } from '../views/chatTags.js';
import { chatGroupColorValue, chatGroupLabel, type ChatGroup, type ChatGroupColor } from '../views/chatGroups.js';

export type PickerCreate = { kind: 'group'; name: string | null; color: ChatGroupColor } | { kind: 'tag'; name: string };

/**
 * One picker for a chat's group and tags, over one chat or several: a search
 * field, **Create group / tag…** first, then the Groups (a dot and the name) and
 * the Tags (#name), each A to Z. A group is one at most: picking the chat's own
 * group again, or **No group**, clears it. Tags toggle, so several can be on; with
 * several chats a tag is on when every one has it.
 *
 * Arrow keys move through the options, Enter picks, Escape closes (or leaves
 * the create form). Focus stays in the search field, which names the active option.
 */
export function ChatGroupTagPicker({ groups, tags, chats, resolve, onPickGroup, onToggleTag, onCreate, onClose, initialCreating = false }: {
  groups: ReadonlyArray<ChatGroup>;
  tags: ReadonlyArray<string>;
  /** The chats being edited: what each has now. */
  chats: ReadonlyArray<{ chatGroup?: string | null; tags?: string[] | null }>;
  resolve: (raw: string | null | undefined) => ChatGroup | null;
  /** The group to put the chats in, or null to take them out of theirs. */
  onPickGroup: (group: ChatGroup | null) => void;
  onToggleTag: (tag: string) => void;
  onCreate: (input: PickerCreate) => void;
  onClose: () => void;
  initialCreating?: boolean;
}) {
  const uid = useId();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(initialCreating);
  const [kind, setKind] = useState<'group' | 'tag'>('group');
  // The highlighted option; -1 is none. The pointer highlights only while it is over an option.
  const [active, setActive] = useState(-1);
  const [tagName, setTagName] = useState('');

  const sections = pickerSections(groups, tags, query);
  const hasGroup = chats.some((c) => resolve(c.chatGroup) !== null);
  const options = pickerOptions(sections, hasGroup);
  const current = Math.min(active, options.length - 1);
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const groupOn = (g: ChatGroup) => chats.length > 0 && chats.every((c) => resolve(c.chatGroup)?.key === g.key);

  const pick = (option: PickerOption) => {
    if (option.kind === 'create') { setTagName(query); setCreating((c) => !c); return; }
    if (option.kind === 'no-group') onPickGroup(null);
    else if (option.kind === 'group') onPickGroup(groupOn(option.group) ? null : option.group);
    else onToggleTag(option.tag);
  };
  const closeForm = () => { setCreating(false); search.current?.focus(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(movePickerIndex(current, e.key === 'ArrowDown' ? 1 : -1, options.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (options[current]) pick(options[current]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (creating) closeForm(); else onClose();
    }
  };

  const row = (i: number, selected: boolean, mixed: boolean, content: React.ReactNode, option: PickerOption, extra: Record<string, unknown> = {}) => (
    <div
      key={i}
      id={optionId(i)}
      role="option"
      aria-selected={selected}
      data-active={i === current || undefined}
      data-mixed={mixed || undefined}
      className="chat-picker-option"
      onMouseEnter={() => setActive(i)}
      onMouseLeave={() => setActive((a) => (a === i ? -1 : a))}
      // Keep focus in the search field while the pointer picks.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pick(option)}
      {...extra}
    >
      {content}
    </div>
  );

  let at = 0;
  const createIndex = at++;
  const noGroupIndex = hasGroup ? at++ : -1;
  const groupIndexes = sections.groups.map(() => at++);
  const tagIndexes = sections.tags.map(() => at++);
  const groupsLabel = `${uid}-groups`;
  const tagsLabel = `${uid}-tags`;
  const checkSlot = (state: 'on' | 'some' | 'off') => (
    <span className="chat-picker-check" aria-hidden>
      {state === 'on' ? <CheckIcon className="h-3.5 w-3.5 text-accent" /> : state === 'some' ? <span className="chat-picker-mixed" /> : null}
    </span>
  );

  return (
    <div className="chat-picker" data-chat-group-tag-picker role="dialog" aria-label="Group and tags" onKeyDown={onKeyDown}>
      <input
        ref={search}
        autoFocus={!initialCreating}
        type="text"
        role="combobox"
        aria-label="Search groups and tags"
        aria-expanded="true"
        aria-controls={`${uid}-list`}
        aria-activedescendant={current >= 0 && !creating ? optionId(current) : undefined}
        aria-autocomplete="list"
        className="quiet-field w-full text-xs"
        placeholder="Search groups and tags"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(e.target.value.trim() ? 0 : -1); }}
        data-chat-picker-search
      />
      {creating ? (
        <div className="chat-picker-form" data-picker-create-form onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeForm(); } else e.stopPropagation(); }}>
          <div role="radiogroup" aria-label="Create a" className="chat-picker-kinds">
            {(['group', 'tag'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                className="chat-picker-kind"
                onClick={() => setKind(k)}
                onKeyDown={(e) => { if (e.key.startsWith('Arrow')) { e.preventDefault(); setKind(k === 'group' ? 'tag' : 'group'); } }}
              >
                {k === 'group' ? 'Group' : 'Tag'}
              </button>
            ))}
          </div>
          {kind === 'group'
            ? <NewChatGroupForm initialName={query} onSubmit={(name, color) => { onCreate({ kind: 'group', name, color }); setQuery(''); closeForm(); }} onCancel={closeForm} />
            : (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); const name = normalizeChatTag(tagName); if (name) { onCreate({ kind: 'tag', name }); setTagName(''); setQuery(''); closeForm(); } }}
              >
                <input autoFocus className="quiet-field w-full text-xs" placeholder="Tag name" aria-label="Tag name" maxLength={MAX_CHAT_TAG_LENGTH + 1} value={tagName} onChange={(e) => setTagName(e.target.value)} />
                <div className="flex items-center justify-end gap-2">
                  <button type="submit" className="btn btn-primary px-2 py-1 text-2xs" disabled={!normalizeChatTag(tagName)}>Create tag</button>
                </div>
              </form>
            )}
        </div>
      ) : (
      <div id={`${uid}-list`} role="listbox" aria-label="Groups and tags" aria-multiselectable="true" className="chat-picker-list">
        {row(createIndex, false, false, <><span className="chat-picker-lead" aria-hidden>+</span><span className="min-w-0 flex-1 truncate">Create group / tag…</span></>, { kind: 'create' }, { 'data-picker-create': '' })}
        {(sections.groups.length > 0 || hasGroup) && (
          <div role="group" aria-labelledby={groupsLabel} className="chat-picker-section" data-picker-section="groups">
            <div id={groupsLabel} className="chat-picker-label">Groups</div>
            {hasGroup && row(noGroupIndex, false, false, <><span className="chat-picker-lead" aria-hidden /><span className="min-w-0 flex-1 truncate text-ink-soft">No group</span></>, { kind: 'no-group' }, { 'data-picker-no-group': '' })}
            {sections.groups.map((g, n) => row(groupIndexes[n], groupOn(g), false, (
              <>
                <span className="chat-picker-lead" aria-hidden><span className="chat-picker-dot" style={{ background: chatGroupColorValue(g.color) }} /></span>
                {g.name
                  ? <span className="min-w-0 flex-1 truncate" dir="auto">{g.name}</span>
                  : <span className="min-w-0 flex-1 truncate text-ink-faint">Untitled group</span>}
                {checkSlot(groupOn(g) ? 'on' : 'off')}
              </>
            ), { kind: 'group', group: g }, { 'data-picker-group': g.key, 'aria-label': chatGroupLabel(g) }))}
          </div>
        )}
        {sections.tags.length > 0 && (
          <div role="group" aria-labelledby={tagsLabel} className="chat-picker-section" data-picker-section="tags">
            <div id={tagsLabel} className="chat-picker-label">Tags</div>
            {sections.tags.map((t, n) => {
              const state = chatTagState(chats as Array<{ tags?: string[] | null }>, t);
              return row(tagIndexes[n], state === 'all', state === 'some', (
                <>
                  <span className="chat-picker-lead text-ink-faint" aria-hidden>#</span>
                  <span className="min-w-0 flex-1 truncate" dir="auto">{t}</span>
                  {checkSlot(state === 'all' ? 'on' : state === 'some' ? 'some' : 'off')}
                </>
              ), { kind: 'tag', tag: t }, { 'data-picker-tag': t, 'aria-label': `#${t}` });
            })}
          </div>
        )}
        {query && sections.groups.length === 0 && sections.tags.length === 0 && <p className="chat-picker-empty">Nothing matches. Create it with the first option.</p>}
      </div>
      )}
    </div>
  );
}

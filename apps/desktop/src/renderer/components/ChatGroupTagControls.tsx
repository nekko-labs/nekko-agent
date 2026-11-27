import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { chatWithHeld, heldReadyToApply, heldVersion, holdChoice, isUnsent, subscribeHeld, takeHeld } from './chatGroupHold.js';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { ChatGroupTagPicker, type PickerCreate } from './ChatGroupTagPicker.js';
import { useFloatingMenu } from './floatingMenu.js';
import { assignChatGroupPlan, chatGroupColorValue, chatGroupLabel, createChatGroup, type ChatGroup } from '../views/chatGroups.js';
import { addStoredChatTag, normalizeChatTags, toggleChatTag, chatTagKey } from '../views/chatTags.js';
import { chatGroupTagCatalog, useChatGroupPrefs } from '../views/useChatGroupPrefs.js';

type Patch = { chatGroup?: string | null; tags?: string[] };


/** Save patches on chats; one failure does not stop the rest. A toast names each failure, and the list refreshes. */
export async function saveChatPatches(entries: ReadonlyArray<[string, Patch]>): Promise<void> {
  const results = await Promise.allSettled(entries.map(async ([id, patch]) => {
    const saved = await window.nekko.setSessionOptions(id, patch);
    if (!saved) throw new Error('Chat no longer exists');
    // An open pane's header shows its own copy of the chat.
    window.dispatchEvent(new CustomEvent('nekko-session-brain', { detail: { id, session: saved } }));
  }));
  results.forEach((r, i) => { if (r.status === 'rejected') useStore.getState().pushToast('error', `${entries[i][0]}: ${String(r.reason)}`); });
  await useStore.getState().refreshSessions();
}

/** What the picker reads and does for some chats: their group and tags, the known ones, and the saves. */
export function useChatGroupTagActions(ids: ReadonlyArray<string>, hold = false) {
  const sessions = useStore((s) => s.sessions);
  const prefs = useChatGroupPrefs();
  // Re-read when a held choice changes, from any control.
  useSyncExternalStore(subscribeHeld, heldVersion, heldVersion);
  const catalog = useMemo(() => chatGroupTagCatalog(sessions, prefs.defined, prefs.storedTags), [sessions, prefs.defined, prefs.storedTags]);
  const chats = ids.map((id) => {
    const s = sessions.find((x) => x.id === id);
    return chatWithHeld(id, s, hold && isUnsent(s));
  });
  /** Save now, or hold: for a chat that does not exist yet, and (with `hold`) for one with no messages. */
  const apply = (entries: Array<[string, Patch]>) => {
    const now: Array<[string, Patch]> = [];
    for (const [id, patch] of entries) {
      const c = chats.find((x) => x.id === id);
      if (c?.exists && !(hold && isUnsent(sessions.find((x) => x.id === id)))) now.push([id, patch]);
      else holdChoice(id, patch);
    }
    if (now.length > 0) void saveChatPatches(now);
  };
  const pickGroup = (group: ChatGroup | null) => {
    const plan = assignChatGroupPlan(prefs.defined, group);
    if (plan.defined.length !== prefs.defined.length) prefs.updateDefined(plan.defined);
    apply(ids.map((id): [string, Patch] => [id, { chatGroup: plan.value }]));
  };
  const toggleTag = (tag: string) => {
    const next = toggleChatTag(chats, tag);
    apply(ids.flatMap((id, i): Array<[string, Patch]> => (next[i] ? [[id, { tags: next[i]! }]] : [])));
  };
  const create = (input: PickerCreate) => {
    if (input.kind === 'group') {
      const made = createChatGroup(prefs.defined, { name: input.name, color: input.color });
      if (!made) return;
      prefs.updateDefined(made.defined);
      apply(ids.map((id): [string, Patch] => [id, { chatGroup: made.entry.id }]));
    } else {
      prefs.updateStoredTags(addStoredChatTag(prefs.storedTags, input.name));
      apply(ids.flatMap((id, i): Array<[string, Patch]> => {
        const has = normalizeChatTags(chats[i].tags).some((t) => chatTagKey(t) === chatTagKey(input.name));
        return has ? [] : [[id, { tags: normalizeChatTags([...(chats[i].tags ?? []), input.name]) }]];
      }));
    }
  };
  return { chats, catalog, pickGroup, toggleTag, create };
}

/**
 * Save what was chosen for new chats once their first message is sent (the
 * chat has a message), and drop it if the chat is discarded first. Mount it
 * where the choice can be made.
 */
export function useApplyHeldChatGroupTags(ids: ReadonlyArray<string>): void {
  const sessions = useStore((s) => s.sessions);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const ready = heldReadyToApply(ids, sessions);
    ids.forEach((id) => {
      if (sessions.some((s) => s.id === id)) seen.current.add(id);
      else if (seen.current.has(id)) { seen.current.delete(id); takeHeld(id); }
    });
    if (ready.length === 0) return;
    const entries = ready.map((id): [string, Patch] => [id, takeHeld(id)!]);
    void saveChatPatches(entries);
  }, [ids.join('\0'), sessions]);
}

/** The picker for these chats, wired to the saves. Picking a group, toggling a tag or creating keeps it open; clicking outside or Escape closes it. */
export function ChatGroupTagPickerFor({ ids, onClose, hold = false }: { ids: ReadonlyArray<string>; onClose: () => void; hold?: boolean }) {
  const { chats, catalog, pickGroup, toggleTag, create } = useChatGroupTagActions(ids, hold);
  return (
    <ChatGroupTagPicker
      groups={catalog.groups}
      tags={catalog.tags}
      chats={chats}
      resolve={catalog.index.resolve}
      onPickGroup={pickGroup}
      onToggleTag={toggleTag}
      onCreate={create}
      onClose={onClose}
    />
  );
}

/** The picker as a popover anchored to a button. */
export function ChatGroupTagPopover({ ids, anchor, onClose, hold = false }: { ids: ReadonlyArray<string>; anchor: React.RefObject<HTMLElement | null>; onClose: () => void; hold?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const style = useFloatingMenu(true, anchor, 300, 420);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="card fixed z-[1000] overflow-y-auto p-2 shadow-(--shadow-float)" style={style} data-chat-group-tag-popover>
      <ChatGroupTagPickerFor ids={ids} onClose={onClose} hold={hold} />
    </div>,
    document.body,
  );
}

const FolderTagIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
);

/**
 * A new chat's group and tags: a compact button in the composer's bar, next to
 * the model, that opens the picker. Only a chat with no messages offers it (after
 * that the header's breadcrumb and the Agents panel's menu do). A choice made
 * before the chat exists is held and saved once it does.
 */
export function ChatGroupTagButton({ sessionId }: { sessionId: string }) {
  const summary = useStore((s) => s.sessions.find((x) => x.id === sessionId)) as SessionSummary | undefined;
  const ids = useMemo(() => [sessionId], [sessionId]);
  useApplyHeldChatGroupTags(ids);
  const { chats, catalog } = useChatGroupTagActions(ids, true);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (summary && summary.messageCount > 0) return null;
  const group = catalog.index.resolve(chats[0].chatGroup);
  const tagCount = normalizeChatTags(chats[0].tags).length;
  const label = group ? `Group: ${chatGroupLabel(group)}` : 'Group and tags';
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="btn btn-ghost shrink-0 gap-1 px-2 py-1 text-2xs"
        title={label + (tagCount > 0 ? `, ${tagCount} tag${tagCount === 1 ? '' : 's'}` : '')}
        aria-label="Group and tags"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-chat-group-tag-button
        onClick={() => setOpen((o) => !o)}
      >
        {group ? <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: chatGroupColorValue(group.color) }} /> : <FolderTagIcon />}
        {group?.name && <span className="max-w-24 truncate" dir="auto">{group.name}</span>}
        {tagCount > 0 && <span className="text-ink-faint">#{tagCount}</span>}
      </button>
      {open && <ChatGroupTagPopover ids={ids} anchor={anchor} onClose={() => setOpen(false)} hold />}
    </>
  );
}

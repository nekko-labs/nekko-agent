import { useCallback, useEffect, useState } from 'react';
import { CHAT_GROUP_PREFS_EVENT, buildChatGroupIndex, readDefinedChatGroups, saveDefinedChatGroups, type DefinedChatGroup } from './chatGroups.js';
import { knownChatTags, readStoredChatTags, saveStoredChatTags } from './chatTags.js';

/**
 * The defined chat groups and the saved tag list, shared by every view of them
 * (the Agents panel, the chat header, the composer): saving from one re-reads in
 * the others, in this window and, through `storage`, in the others.
 */
export function useChatGroupPrefs() {
  const [defined, setDefined] = useState<DefinedChatGroup[]>(readDefinedChatGroups);
  const [storedTags, setStoredTags] = useState<string[]>(readStoredChatTags);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reread = () => { setDefined(readDefinedChatGroups()); setStoredTags(readStoredChatTags()); };
    window.addEventListener(CHAT_GROUP_PREFS_EVENT, reread);
    window.addEventListener('storage', reread);
    return () => { window.removeEventListener(CHAT_GROUP_PREFS_EVENT, reread); window.removeEventListener('storage', reread); };
  }, []);
  const updateDefined = useCallback((next: DefinedChatGroup[]) => { setDefined(next); saveDefinedChatGroups(next); }, []);
  const updateStoredTags = useCallback((next: string[]) => { setStoredTags(next); saveStoredChatTags(next); }, []);
  return { defined, updateDefined, storedTags, updateStoredTags };
}

/** The groups and tags the picker offers: the saved lists plus what every chat carries. */
export function chatGroupTagCatalog(sessions: ReadonlyArray<{ chatGroup?: string | null; tags?: string[] | null }>, defined: ReadonlyArray<DefinedChatGroup>, storedTags: ReadonlyArray<string>) {
  const index = buildChatGroupIndex(sessions, defined);
  return { index, groups: index.groups, tags: knownChatTags(sessions, storedTags) };
}

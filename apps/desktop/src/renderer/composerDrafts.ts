import { readBrandKey } from './brandStorage.js';

/**
 * Unsent composer text and pending images, kept per chat.
 *
 * The workbench only mounts the pane you are looking at, so switching tabs,
 * leaving the Chat view, or quitting the app all tear the composer down. Parking
 * the draft here means it is still waiting when you come back.
 */

const KEY = 'nekko.composerDrafts';

/**
 * Rough ceiling for the whole draft map. Pending images are data URLs, so a
 * couple of pasted screenshots run to megabytes and localStorage gives us about
 * 5MB. Past the budget we drop the least recently touched drafts rather than let
 * a write fail and lose everything.
 */
const BUDGET = 4_000_000;

export interface ComposerDraft {
  text: string;
  /** Pending image attachments, as data URLs (same shape the composer holds). */
  images: string[];
  savedAt: number;
}

type DraftMap = Record<string, ComposerDraft>;

function readAll(): DraftMap {
  if (typeof window === 'undefined') return {};
  try {
    const parsed: unknown = JSON.parse(readBrandKey(window.localStorage, KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return {};
    const out: DraftMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const d = value as Partial<ComposerDraft> | null;
      if (!d || typeof d.text !== 'string') continue;
      out[id] = {
        text: d.text,
        images: Array.isArray(d.images) ? d.images.filter((i): i is string => typeof i === 'string') : [],
        savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Write the map, making room in the order that loses the least: first the
 * pictures in other chats' drafts (oldest first), then other chats' words
 * (oldest first). If the chat being saved is on its own and still too big,
 * keep its words and drop its pictures. Typed text is the one thing a draft
 * cannot get back, so it is always the last to go.
 */
function writeAll(map: DraftMap, keepId: string): void {
  if (typeof window === 'undefined') return;
  for (;;) {
    const json = JSON.stringify(map);
    if (json.length <= BUDGET) {
      try {
        window.localStorage.setItem(KEY, json);
        return;
      } catch {
        // Quota: fall through and evict.
      }
    }
    const others = Object.entries(map)
      .filter(([id]) => id !== keepId)
      .sort((a, b) => a[1].savedAt - b[1].savedAt);
    const withImages = others.find(([, d]) => d.images.length > 0);
    if (withImages) {
      const [id, d] = withImages;
      if (d.text.trim()) map[id] = { ...d, images: [] };
      else delete map[id];
      continue;
    }
    const oldest = others[0];
    if (oldest) {
      delete map[oldest[0]];
      continue;
    }
    const kept = map[keepId];
    if (kept?.images.length) {
      map[keepId] = { ...kept, images: [] };
      continue;
    }
    try {
      window.localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
      // Persistence is best-effort in restricted/browser transports.
    }
    return;
  }
}

/** The parked draft for a chat, or null when there is nothing to restore. */
export function loadDraft(sessionId: string): ComposerDraft | null {
  return readAll()[sessionId] ?? null;
}

/** Park a draft. An empty one (no text, no images) clears the entry instead. */
export function saveDraft(sessionId: string, draft: { text: string; images: string[] }): void {
  const empty = !draft.text.trim() && draft.images.length === 0;
  const map = readAll();
  if (empty) {
    if (!(sessionId in map)) return;
    delete map[sessionId];
  } else {
    const current = map[sessionId];
    // Nothing changed, so don't churn localStorage on every keystroke's debounce.
    if (
      current &&
      current.text === draft.text &&
      current.images.length === draft.images.length &&
      current.images.every((image, i) => image === draft.images[i])
    ) {
      return;
    }
    map[sessionId] = { text: draft.text, images: [...draft.images], savedAt: Date.now() };
  }
  writeAll(map, sessionId);
}

/** Forget a chat's draft (it was sent, queued, or the chat is gone). */
export function clearDraft(sessionId: string): void {
  saveDraft(sessionId, { text: '', images: [] });
}

/** Keep the mounted attachment array when the restored draft holds the same images, so a switch does not re-render them. */
export function restoredDraftImages(current: string[], restored?: string[]): string[] {
  if (!restored) return current.length === 0 ? current : [];
  return current.length === restored.length && current.every((image, i) => image === restored[i]) ? current : restored;
}

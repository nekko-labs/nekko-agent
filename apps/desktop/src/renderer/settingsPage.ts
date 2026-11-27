import { useStore } from './store.js';

/** Fired with the Settings page id to show; SettingsView listens while it is open. */
export const SETTINGS_PAGE_EVENT = 'nekko:settings-page';

let pending: string | null = null;

/** Open Settings on one page (e.g. `storage`), whether or not Settings is already showing. */
export function openSettingsPage(id: string) {
  pending = id;
  useStore.getState().setView('settings');
  window.dispatchEvent(new CustomEvent(SETTINGS_PAGE_EVENT, { detail: id }));
}

/** The page asked for before Settings mounted, once. */
export function takePendingSettingsPage(): string | null {
  const id = pending;
  pending = null;
  return id;
}

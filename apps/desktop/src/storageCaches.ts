/** Settings → Storage, App caches: the desktop app's own browser caches (main process only). */
export const STORAGE_CLEAR_CACHES_CHANNEL = 'storage:clearCaches';

type CacheSession = Pick<import('electron').Session, 'clearCache' | 'clearCodeCaches' | 'clearStorageData'>;

/** HTTP, code, service worker, cache storage and shader caches; never cookies, local storage or IndexedDB. */
export async function clearAppCaches(s: CacheSession): Promise<void> {
  await s.clearCache();
  await s.clearCodeCaches({});
  await s.clearStorageData({ storages: ['serviceworkers', 'cachestorage', 'shadercache'] });
}

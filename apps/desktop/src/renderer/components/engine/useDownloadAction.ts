import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createDownloadActions, type DownloadTarget } from './downloadActionState.js';

const actions = createDownloadActions();
let subscribers = 0;
let disconnect: (() => void) | undefined;

/** Share the host feed and optimistic locks across model and runtime surfaces. */
export function useDownloadAction(target: DownloadTarget) {
  useStore(actions.store);
  useEffect(() => {
    if (subscribers++ === 0) {
      let live = true;
      let version = 0;
      const refresh = async () => {
        const current = ++version;
        try {
          const jobs = await window.nekko.engineDownloads();
          if (live && current === version && Array.isArray(jobs)) actions.update(jobs);
        } catch { /* Keep a known in-flight download locked if the host is unavailable. */ }
      };
      const off = window.nekko.onDownloadsUpdated(jobs => { version++; actions.update(jobs); });
      void refresh();
      const timer = setInterval(refresh, 2000);
      disconnect = () => { live = false; off(); clearInterval(timer); };
    }
    return () => { if (--subscribers === 0) { disconnect?.(); disconnect = undefined; } };
  }, []);
  return { ...actions.status(target), run: (request: Parameters<typeof actions.run>[1]) => actions.run(target, request) };
}

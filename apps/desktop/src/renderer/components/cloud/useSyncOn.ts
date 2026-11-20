import { useEffect, useState } from 'react';
import type { CloudStatus } from '@nekko-agent/shared';

const SYNCING = new Set(['idle', 'syncing', 'error']);

/** True while sync is set up and switched on for this computer, with Chats among what syncs (#3089). */
export const syncOn = (s: CloudStatus | null | undefined) =>
  !!s?.signedIn && s.sync.enabled && SYNCING.has(s.sync.phase) && s.sync.kinds?.chats !== false;

/** Whether this computer syncs chats, kept live (a chat's Sync switch only means something then). */
export function useSyncOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    const read = (s: CloudStatus) => { if (live) setOn(syncOn(s)); };
    window.nekko.cloudStatus?.().then(read).catch(() => {});
    const off = window.nekko.onCloudStatus?.(read);
    return () => { live = false; off?.(); };
  }, []);
  return on;
}

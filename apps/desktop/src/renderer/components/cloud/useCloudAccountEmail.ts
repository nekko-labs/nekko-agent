import { useEffect, useState } from 'react';
import type { CloudStatus } from '@nekko-agent/shared';

/** The current account address, not a saved preference or an update-mail opt-in. */
export function useCloudAccountEmail(): string {
  const [email, setEmail] = useState('');
  useEffect(() => {
    let live = true;
    let receivedEvent = false;
    const read = (status: CloudStatus | null) => {
      if (live) setEmail(status?.signedIn ? status.account?.email?.trim() ?? '' : '');
    };
    const off = window.nekko.onCloudStatus?.((status) => {
      receivedEvent = true;
      read(status);
    });
    // A sign-in/out event can arrive before the initial status request returns.
    window.nekko.cloudStatus?.().then((status) => {
      if (!receivedEvent) read(status);
    }).catch(() => {});
    return () => { live = false; off?.(); };
  }, []);
  return email;
}

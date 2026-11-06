import type { Notice } from '../notificationPolicy.js';
import { notificationLink } from './notifications.js';

export interface NativeNotice {
  once(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
  close(): void;
  show(): void;
}
export interface NativeNotificationAdapter {
  isSupported(): boolean;
  create(options: { title: string; body: string; silent: boolean; icon?: string; toastXml?: string }): NativeNotice;
  /** Windows only: post toasts that carry their link. The value is the icon's file on disk, if any. */
  windowsToast?: { icon?: string };
}

/** A live toast reports one click twice: as its `click` event and as an activation. */
const SAME_CLICK_MS = 2000;

/** XML 1.0 has no control characters, and one of them would fail the whole toast. */
function xmlEscape(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cs}￾￿]/gu, match => (match === '\t' || match === '\n' || match === '\r' ? match : ''))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Electron's own toast, plus a `launch` argument. Without one, a click on a
 * toast that has left the screen for the notification centre reaches the app
 * with nothing to say which chat it was for.
 */
export function windowsToastXml(toast: { title: string; body: string; silent: boolean; icon?: string; link: string }): string {
  const image = toast.icon ? `<image id="1" placement="appLogoOverride" hint-crop="none" src="${xmlEscape(toast.icon)}"/>` : '';
  const text = [toast.title, toast.body].filter(Boolean).map(line => `<text>${xmlEscape(line)}</text>`).join('');
  const audio = toast.silent ? '<audio silent="true"/>' : '';
  return `<toast launch="${xmlEscape(toast.link)}"><visual><binding template="ToastGeneric">${text}${image}</binding></visual>${audio}</toast>`;
}

/** Injection keeps integration checks off the user's OS notification service. */
export function createNativeNotificationPoster(adapter: NativeNotificationAdapter, deliverLink: (url: string) => void, icon?: string) {
  const retained = new Set<NativeNotice>();
  let disposed = false;
  let opened: { link: string; at: number } | null = null;
  const open = (link: string) => {
    const now = Date.now();
    if (disposed || (opened?.link === link && now - opened.at < SAME_CLICK_MS)) return;
    opened = { link, at: now };
    deliverLink(link);
  };
  return {
    post(notice: Notice) {
      if (disposed || !adapter.isSupported()) return;
      const link = notice.link ?? notificationLink(notice.sessionId);
      const silent = notice.kind === 'finished' || notice.kind === 'run-finished';
      const toastXml = adapter.windowsToast && windowsToastXml({ title: notice.title, body: notice.body, silent, icon: adapter.windowsToast.icon, link });
      const notification = adapter.create({ title: notice.title, body: notice.body, silent, icon, ...(toastXml ? { toastXml } : {}) });
      if (retained.size >= 8) {
        const oldest = retained.values().next().value;
        oldest?.close();
        if (oldest) retained.delete(oldest);
      }
      retained.add(notification);
      notification.once('click', () => {
        open(link);
        notification.close();
      });
      notification.once('close', () => retained.delete(notification));
      notification.once('failed', () => retained.delete(notification));
      notification.show();
    },
    /** A click Windows reports by its `launch` argument, whether or not the toast is still held here. */
    activated(launch: string) {
      if (launch.startsWith('nekko-agent://')) open(launch);
    },
    dispose() {
      disposed = true;
      for (const notification of retained) notification.close();
      retained.clear();
    },
  };
}

import type { Notice } from '../notificationPolicy.js';
import { notificationLink } from './notifications.js';

export interface NativeNotice {
  once(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
  close(): void;
  show(): void;
}
export interface NativeNotificationAdapter {
  isSupported(): boolean;
  create(options: { title: string; body: string; silent: boolean; icon?: string }): NativeNotice;
}

/** Injection keeps integration checks off the user's OS notification service. */
export function createNativeNotificationPoster(adapter: NativeNotificationAdapter, deliverLink: (url: string) => void, icon?: string) {
  const retained = new Set<NativeNotice>();
  let disposed = false;
  return {
    post(notice: Notice) {
      if (disposed || !adapter.isSupported()) return;
      const notification = adapter.create({ title: notice.title, body: notice.body, silent: notice.kind === 'finished', icon });
      if (retained.size >= 8) {
        const oldest = retained.values().next().value;
        oldest?.close();
        if (oldest) retained.delete(oldest);
      }
      retained.add(notification);
      notification.once('click', () => {
        if (!disposed) deliverLink(notificationLink(notice.sessionId));
        notification.close();
      });
      notification.once('close', () => retained.delete(notification));
      notification.once('failed', () => retained.delete(notification));
      notification.show();
    },
    dispose() {
      disposed = true;
      for (const notification of retained) notification.close();
      retained.clear();
    },
  };
}

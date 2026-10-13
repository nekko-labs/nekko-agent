import type { NekkoApi } from '@nekko-agent/shared';

declare global {
  interface Window {
    nekko: NekkoApi;
    /**
     * The window-chrome bridge, present only in the Electron shell (see
     * `chrome.ts`). Absent in a browser tab and in the Capacitor builds, which
     * have chrome of their own.
     */
    nekkoChrome?: {
      reportNotificationVisibility: (report: import('../notificationVisibility.js').NotificationVisibilityReport) => void;
      platform: string;
      titleBarHeight: number;
      setTitleBarOverlay: (theme: { color: string; symbolColor: string }) => void;
    };
  }
}

export {};

/** Shell-only IPC, deliberately absent from the public host contract. */
export const NOTIFICATION_VISIBILITY_CHANNEL = 'chrome:notification-visibility';
export interface NotificationVisibilityReport {
  view: string;
  activeSessionId: string | null;
}

export function visibleNotificationSession(report: unknown): string | null {
  if (!report || typeof report !== 'object') return null;
  const { view, activeSessionId } = report as NotificationVisibilityReport;
  // Wall panes can be collapsed or offscreen. Never suppress based on selection alone.
  return view === 'chat' && typeof activeSessionId === 'string' && activeSessionId.length > 0
    ? activeSessionId : null;
}

/** The view on screen, for notices about a whole view (workflow runs). */
export function visibleNotificationView(report: unknown): string | null {
  if (!report || typeof report !== 'object') return null;
  const { view } = report as NotificationVisibilityReport;
  return typeof view === 'string' && view.length > 0 ? view : null;
}

export function trustedNotificationReporter(owned: boolean, senderFrame: unknown, mainFrame: unknown): boolean {
  return owned && mainFrame != null && senderFrame === mainFrame;
}

export interface NotificationWindowState {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
}
export function notificationWindowContext(win: NotificationWindowState | null, visibleSessionId: string | null, visibleView: string | null = null) {
  return {
    windowHidden: !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused(),
    visibleSessionId,
    visibleView,
  };
}

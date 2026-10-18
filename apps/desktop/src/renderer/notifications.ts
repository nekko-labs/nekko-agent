/**
 * Browser notifications for unattended chats. Electron main owns native
 * notifications independently of this page; here the desktop shell only
 * listens for notification clicks that select a session.
 */

import type { AgentEvent, WorkflowsSnapshot } from '@nekko-agent/shared';
import { decideNotification, decideRunNotice, parseWorkflowRunLink, type NotificationContext, type Notice } from '../notificationPolicy.js';
export { decideNotification, parseWorkflowRunLink, type NotificationContext, type Notice } from '../notificationPolicy.js';
import { useStore } from './store.js';

/** The same notice is not repeated within this window (a retry storm, a double event). */
const DEDUPE_MS = 5_000;

/**
 * Listen for the whole app. Returns the unsubscribe. Permission is asked once,
 * the first time a notice is due, so a user who never leaves a chat unattended
 * is never prompted.
 */
export function startDesktopNotifications(): () => void {
  if (window.nekkoChrome) {
    const report = () => {
      const { view, activeSessionId } = useStore.getState();
      window.nekkoChrome?.reportNotificationVisibility?.({ view, activeSessionId });
    };
    report();
    const offStore = useStore.subscribe((state, previous) => {
      if (state.view !== previous.view || state.activeSessionId !== previous.activeSessionId) report();
    });
    const offLink = window.nekko.onDeepLink((url) => {
      const run = parseWorkflowRunLink(url);
      if (run) {
        openWorkflowRun(run);
        return;
      }
      const sessionId = notificationSessionId(url);
      if (!sessionId) return;
      const s = useStore.getState();
      s.setActiveSession(sessionId);
      s.setView('chat');
      // Focus the session's workspace pane (or create one if it was closed);
      // setActiveSession/setView alone never touch the workbench layout.
      s.openChatPane(sessionId);
    });
    return () => { offStore(); offLink(); };
  }
  if (typeof Notification === 'undefined') return () => {};
  const recent = new Map<string, number>();
  let shown: Notification[] = [];
  const context = (): NotificationContext => {
    const s = useStore.getState();
    return {
      enabled: s.settings?.desktopNotifications !== false,
      windowHidden: document.hidden || !document.hasFocus(),
      visibleSessionId: s.view === 'chat' ? s.activeSessionId : null,
      titleOf: (id) => s.sessions.find((x) => x.id === id)?.title,
    };
  };
  const post = (notice: Notice) => {
    const key = `${notice.sessionId}:${notice.kind}`;
    const now = Date.now();
    if ((recent.get(key) ?? 0) > now - DEDUPE_MS) return;
    recent.set(key, now);
    try {
      const n = new Notification(notice.title, { body: notice.body, tag: key, silent: notice.kind === 'finished' });
      n.onclick = () => {
        window.focus();
        const run = notice.link ? parseWorkflowRunLink(notice.link) : null;
        if (run) openWorkflowRun(run);
        else {
          const s = useStore.getState();
          s.setActiveSession(notice.sessionId);
          s.setView('chat');
          // Focus the session's workspace pane (or create one if it was closed).
          s.openChatPane(notice.sessionId);
        }
        n.close();
      };
      shown = [...shown.filter((x) => x !== n).slice(-7), n];
    } catch {
      /* the platform refused; the pane still shows it */
    }
  };
  const deliver = (notice: Notice) => {
    if (Notification.permission === 'granted') post(notice);
    else if (Notification.permission === 'default') {
      Notification.requestPermission().then((p) => { if (p === 'granted') post(notice); }).catch(() => {});
    }
  };
  const off = window.nekko.onAgentEvent((event: AgentEvent) => {
    const notice = decideNotification(event, context());
    if (notice) deliver(notice);
  });
  // Finished workflow runs: each one once, and only runs that end from now on.
  const since = Date.now();
  const toldRuns = new Set<string>();
  const offRuns = window.nekko.onWorkflowsUpdated((snapshot: WorkflowsSnapshot) => {
    const { enabled, windowHidden } = context();
    const workflowsVisible = !windowHidden && useStore.getState().view === 'workflows';
    for (const run of snapshot.runs) {
      if ((run.status !== 'success' && run.status !== 'failure') || (run.endedAt ?? 0) < since || toldRuns.has(run.id)) continue;
      toldRuns.add(run.id);
      const wf = snapshot.workflows.find((w) => w.id === run.workflowId);
      const notice = wf && decideRunNotice(run, wf, { enabled, workflowsVisible });
      if (notice) deliver(notice);
    }
  });
  return () => {
    off();
    offRuns();
    for (const n of shown) n.close();
    shown = [];
  };
}

/** Only notification session links, never arbitrary commands. */
export function notificationSessionId(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'nekko-agent:' || url.hostname !== 'session' || url.pathname !== '/open') return null;
    return url.searchParams.get('id') || null;
  } catch { return null; }
}

/** Show a workflow run: the Workflows view opens with that run selected. */
export function openWorkflowRun(run: { workflowId: string; runId: string }): void {
  useStore.setState({ workflowFocus: run });
  useStore.getState().setView('workflows');
}


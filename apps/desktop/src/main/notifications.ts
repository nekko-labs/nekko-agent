import { IpcChannels, IpcEvents, type AgentEvent, type AppSettings, type WorkflowsSnapshot } from '@nekko-agent/shared';
import { decideNotification, decideRunNotice, type Notice } from '../notificationPolicy.js';
import type { EngineEndpoint } from './engine-process.js';

export { createNativeNotificationPoster } from './nativeNotifications.js';

interface NotificationEngine {
  endpoint(): Promise<EngineEndpoint>;
  call<T>(channel: string, ...args: unknown[]): Promise<T>;
}

/** Main owns this connection, even with no renderer or a suspended page. */
export function startMainNotifications(
  engine: NotificationEngine,
  post: (notice: Notice) => void,
  makeSocket: (url: string) => WebSocket = url => new WebSocket(url),
  context: () => { windowHidden: boolean; visibleSessionId: string | null; visibleView?: string | null } = () => ({ windowHidden: true, visibleSessionId: null }),
): () => void {
  let disposed = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retry = 250;
  const recent = new Map<string, number>();
  // Runs that ended before this watcher started were someone else's news.
  const since = Date.now();
  const toldRuns = new Set<string>();

  const notify = async (event: AgentEvent) => {
    try {
      // Filter before making requests; token/text events must remain cheap.
      if (!decideNotification(event, { enabled: true, windowHidden: true, visibleSessionId: null, titleOf: () => undefined })) return;
      // Read authoritative settings for each notice, including changes from other clients.
      const settings = await engine.call<AppSettings>(IpcChannels.settingsGet);
      if (disposed || settings?.desktopNotifications === false) return;
      let title: string | undefined;
      try {
        title = (await engine.call<{ title?: string } | null>(IpcChannels.sessionGet, event.sessionId))?.title;
      } catch { /* A deleted chat can still report its final event. */ }
      if (disposed) return;
      // Focus alone is insufficient: another chat or a non-chat view may be showing.
      const notice = decideNotification(event, { enabled: true, ...context(), titleOf: () => title });
      if (!notice) return;
      const now = Date.now();
      for (const [key, time] of recent) if (time <= now - 5000) recent.delete(key);
      const key = `${notice.sessionId}:${notice.kind}`;
      if (recent.has(key)) return;
      post(notice);
      recent.set(key, now);
    } catch { /* Settings unavailable: do not bypass an opt-out. */ }
  };

  /** A finished workflow run, from the `workflows:updated` snapshot every change sends. */
  const notifyRuns = async (snapshot: WorkflowsSnapshot) => {
    const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
    const workflows = Array.isArray(snapshot?.workflows) ? snapshot.workflows : [];
    const fresh = runs.filter((r) => (r.status === 'success' || r.status === 'failure') && (r.endedAt ?? 0) >= since && !toldRuns.has(r.id));
    if (!fresh.length) return;
    for (const r of fresh) toldRuns.add(r.id);
    try {
      const settings = await engine.call<AppSettings>(IpcChannels.settingsGet);
      if (disposed || settings?.desktopNotifications === false) return;
      const { windowHidden, visibleView } = context();
      for (const run of fresh) {
        const wf = workflows.find((w) => w.id === run.workflowId);
        if (!wf) continue;
        const notice = decideRunNotice(run, wf, { enabled: true, workflowsVisible: !windowHidden && visibleView === 'workflows' });
        if (notice) post(notice);
      }
    } catch { /* Settings unavailable: do not bypass an opt-out. */ }
    // Keep the memory to runs still in the history.
    const kept = new Set(runs.map((r) => r.id));
    for (const id of toldRuns) if (!kept.has(id)) toldRuns.delete(id);
  };

  const schedule = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void connect(); }, retry);
    retry = Math.min(retry * 2, 5000);
  };
  const connect = async () => {
    try {
      // Resolve anew after every disconnect: engine restarts can change the port.
      const endpoint = await engine.endpoint();
      if (disposed) return;
      // `sessions=` (none): every chat's summary events (a turn's start, its
      // waits, its end) are all a notice needs; no chat's token stream.
      const ws = makeSocket(`${endpoint.url.replace(/^http/, 'ws')}/api/ws?sessions=&token=${encodeURIComponent(endpoint.token)}`);
      socket = ws;
      const disconnect = () => {
        if (socket !== ws) return;
        socket = null;
        clearTimeout(deadline);
        ws.close();
        schedule();
      };
      deadline = setTimeout(disconnect, 10000);
      ws.onopen = () => {
        if (disposed || socket !== ws) return;
        clearTimeout(deadline);
        retry = 250;
      };
      ws.onclose = disconnect;
      ws.onerror = disconnect;
      ws.onmessage = ({ data }) => {
        if (disposed || socket !== ws) return;
        try {
          const frame = JSON.parse(String(data));
          if (frame.channel === IpcEvents.agentEvent && frame.payload && typeof frame.payload.sessionId === 'string') {
            void notify(frame.payload as AgentEvent);
          } else if (frame.channel === IpcEvents.workflowsUpdated && frame.payload) {
            void notifyRuns(frame.payload as WorkflowsSnapshot);
          }
        } catch { /* Ignore malformed or unrelated frames. */ }
      };
    } catch { schedule(); }
  };
  void connect();
  return () => {
    disposed = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    const ws = socket;
    socket = null;
    ws?.close();
    recent.clear();
    toldRuns.clear();
  };
}

export function notificationLink(sessionId: string): string {
  return `nekko-agent://session/open?id=${encodeURIComponent(sessionId)}`;
}

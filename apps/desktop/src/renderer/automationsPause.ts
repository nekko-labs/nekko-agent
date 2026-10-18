import { useStore } from './store.js';

/**
 * "Pause all automations": scheduled and event triggers stop starting runs
 * (the engine checks `automationsPaused`), and pausing also stops what is
 * already running, workflow runs and scheduled tasks' turns alike. Run buttons
 * keep working, so pausing never locks the user out of their own workflows.
 */
export async function setAutomationsPaused(paused: boolean): Promise<void> {
  const settings = await window.nekko.updateSettings({ automationsPaused: paused });
  useStore.setState({ settings });
  if (!paused) return;
  const [snapshot, tasks, running] = await Promise.all([
    window.nekko.listWorkflows().catch(() => null),
    window.nekko.listTasks().catch(() => []),
    window.nekko.runningSessions().catch(() => []),
  ]);
  const live = new Set(running);
  await Promise.all([
    ...(snapshot?.runs ?? []).filter((r) => r.status === 'running').map((r) => window.nekko.cancelWorkflowRun(r.id).catch(() => {})),
    ...tasks.filter((t) => t.lastSessionId && live.has(t.lastSessionId)).map((t) => window.nekko.abortChat(t.lastSessionId!).catch(() => {})),
  ]);
}

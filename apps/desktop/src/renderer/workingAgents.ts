import { useEffect, useState } from 'react';
import type { AgentEvent, PendingInput } from '@nekko-agent/shared';

/** Membership only: no token buffers or per-token React updates. */
export class WorkingAgents {
  private running = new Set<string>();
  private blocked = new Set<string>();
  private touched = new Set<string>();

  get working(): boolean { return [...this.running].some((id) => !this.blocked.has(id)); }

  /** Events received during startup outrank the older host snapshot. */
  hydrate(running: string[], pending: Record<string, PendingInput>): void {
    for (const id of running) if (!this.touched.has(id)) this.running.add(id);
    for (const [id, input] of Object.entries(pending)) {
      if (!this.touched.has(id) && (input.question || input.approval)) this.blocked.add(id);
    }
  }

  event(e: AgentEvent): void {
    if (e.type === 'done' || e.type === 'error') {
      this.touched.add(e.sessionId);
      this.running.delete(e.sessionId);
      this.blocked.delete(e.sessionId);
    } else if (e.type === 'question' || e.type === 'tool_approval_required') {
      this.touched.add(e.sessionId);
      this.running.add(e.sessionId);
      this.blocked.add(e.sessionId);
    } else if (['text', 'reasoning', 'tool_call', 'tool_result', 'step', 'retry', 'image_status', 'question_resolved'].includes(e.type)) {
      this.touched.add(e.sessionId);
      this.running.add(e.sessionId);
      this.blocked.delete(e.sessionId);
    }
  }
}

// Explicit local sends cover prompt latency before the host emits its first token.
const localStarts = new Set<string>();
const localListeners = new Set<(id: string, working: boolean) => void>();
export function reportAgentWorking(id: string, working: boolean): void {
  if (working) localStarts.add(id); else localStarts.delete(id);
  for (const listener of localListeners) listener(id, working);
}

/** App-lifetime subscription includes background agents, not just mounted panes. */
export function useAnyAgentWorking(): boolean {
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const state = new WorkingAgents();
    let disposed = false;
    let last = false;
    const publish = () => { const next = state.working; if (next !== last) { last = next; setWorking(next); } };
    const local = (id: string, running: boolean) => {
      state.event(running ? { type: 'text', sessionId: id, delta: '' } : { type: 'done', sessionId: id, messageId: '' });
      publish();
    };
    localListeners.add(local);
    for (const id of localStarts) local(id, true);
    const off = window.nekko.onAgentEvent((event) => {
      if (event.type === 'done' || event.type === 'error') localStarts.delete(event.sessionId);
      state.event(event); publish();
    });
    Promise.all([window.nekko.runningSessions(), window.nekko.pendingInput()]).then(([ids, pending]) => {
      if (disposed) return;
      state.hydrate(ids, pending);
      publish();
    }).catch(() => {});
    return () => { disposed = true; off(); localListeners.delete(local); };
  }, []);
  return working;
}

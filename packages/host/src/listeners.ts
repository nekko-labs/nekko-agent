import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectorConfig, ConnectorKind, Workflow, WorkflowEvent, WorkflowTrigger } from '@nekko-agent/shared';
import { getConnector } from '@nekko-agent/core';
import { dataDir } from './paths.js';
import { getSettings } from './store.js';
import { writeJsonAtomic } from './secure-file.js';
import { dispatchWorkflowEvent, listWorkflows } from './workflows.js';

/**
 * Polling trigger listeners.
 *
 * Every armed `connector` trigger gets its own cursor (`lastSeen`) stored in
 * `workflow-cursors.json` beside `workflows.json`. The listener polls the
 * relevant connector on an interval, dispatches each new event through
 * `dispatchWorkflowEvent`, and advances the cursor. Events are deduplicated
 * by their connector-supplied id within a process, and by the cursor across
 * restarts.
 */

const LISTENERS_FILE = 'workflow-cursors.json';
const TICK_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60_000;
const MAX_SEEN = 200;

interface CursorRecord {
  /** The timestamp (epoch ms) the next poll should start after. */
  lastCursor: number;
  /** Recently dispatched event ids, so a late/duplicate page doesn_t refire. */
  seenIds: string[];
  /** Last poll attempt time. */
  lastPollAt: number;
}

interface CursorsFile {
  version: number;
  cursors: Record<string, CursorRecord>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let stopped = false;

/** In-flight guard and deduplication state, keyed by trigger id. */
const state = new Map<string, {
  polling: boolean;
  seen: Set<string>;
  lastPollAt: number;
}>();

function cursorsPath(): string {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, LISTENERS_FILE);
}

function loadCursors(): CursorsFile {
  try {
    const raw = readFileSync(cursorsPath(), 'utf8');
    const parsed = JSON.parse(raw) as CursorsFile;
    if (parsed?.version === 1 && parsed.cursors && typeof parsed.cursors === 'object') {
      return parsed;
    }
  } catch {
    /* missing or malformed: start fresh */
  }
  return { version: 1, cursors: {} };
}

function saveCursors(file: CursorsFile): void {
  writeJsonAtomic(cursorsPath(), file);
}

function getRecord(file: CursorsFile, triggerId: string): CursorRecord {
  const r = file.cursors[triggerId];
  if (r) return r;
  const now = Date.now();
  const rec: CursorRecord = { lastCursor: now, seenIds: [], lastPollAt: 0 };
  file.cursors[triggerId] = rec;
  return rec;
}

/** Every armed connector trigger in the current workflow list. */
function armedConnectorTriggers(): { workflow: Workflow; trigger: WorkflowTrigger }[] {
  const out: { workflow: Workflow; trigger: WorkflowTrigger }[] = [];
  for (const wf of listWorkflows()) {
    if (!wf.enabled) continue;
    for (const t of wf.triggers) {
      if (t.kind === 'connector' && t.enabled !== false && t.connector) {
        out.push({ workflow: wf, trigger: t });
      }
    }
  }
  return out;
}

function connectorSettings(t: WorkflowTrigger, config: ConnectorConfig): Record<string, string> {
  const base: Record<string, string> = { ...config.settings };
  if (t.channel) base.channel = t.channel;
  if (t.repo) base.repo = t.repo;
  if (t.event) base.event = t.event;
  if (t.filter) base.filter = t.filter;
  return base;
}

/** Poll one trigger and dispatch any new events. */
async function pollTrigger(
  wf: Workflow,
  t: WorkflowTrigger,
  record: CursorRecord,
  seen: Set<string>,
): Promise<void> {
  const kind = t.connector as ConnectorKind;
  const connector = getConnector(kind);
  if (!connector.poll) return;
  const config = getSettings().connectors.find((c) => c.kind === kind && c.connected);
  if (!config) return;
  const settings = connectorSettings(t, config);
  const result = await connector.poll(config.token ?? '', settings, record.lastCursor);
  const cursors = loadCursors();
  const rec = getRecord(cursors, t.id);
  let advanced = false;
  for (const ev of result.events) {
    if (ev.cursor <= record.lastCursor || seen.has(ev.id)) continue;
    seen.add(ev.id);
    const event: WorkflowEvent = {
      kind: 'connector',
      connector: kind,
      event: ev.event,
      channel: t.channel,
      text: ev.text,
      payload: ev.payload,
      actor: ev.actor,
    };
    // Repo-scoped connectors: surface the repo so `{{trigger.repo}}` and the
    // status/comment action fallbacks resolve without a step param. The
    // trigger's own repo wins — it's the one the poll was scoped to.
    if (kind === 'github' || kind === 'gitlab') {
      event.repo = t.repo?.trim() || ev.source;
    }
    await dispatchWorkflowEvent(event);
    if (ev.cursor > rec.lastCursor) {
      rec.lastCursor = ev.cursor;
      advanced = true;
    }
  }
  if (result.nextCursor > rec.lastCursor) {
    rec.lastCursor = result.nextCursor;
    advanced = true;
  }
  rec.lastPollAt = Date.now();
  rec.seenIds = [...seen].slice(-MAX_SEEN);
  if (advanced) saveCursors(cursors);
}

/** One polling tick: poll every due connector trigger. */
export async function tickListeners(): Promise<void> {
  if (stopped) return;
  const cursors = loadCursors();
  for (const { workflow: wf, trigger: t } of armedConnectorTriggers()) {
    let s = state.get(t.id);
    if (!s) {
      const rec = getRecord(cursors, t.id);
      s = { polling: false, seen: new Set(rec.seenIds), lastPollAt: rec.lastPollAt };
      state.set(t.id, s);
    }
    if (s.polling) continue;
    const interval = t.pollIntervalMs ?? DEFAULT_INTERVAL_MS;
    if (Date.now() - s.lastPollAt < interval) continue;
    s.polling = true;
    try {
      await pollTrigger(wf, t, getRecord(cursors, t.id), s.seen);
      s.lastPollAt = Date.now();
    } catch (err) {
      // Log quietly; a network or API hiccup should not stop the scheduler.
      console.error(`[workflow-listener] ${t.connector} poll failed for trigger ${t.id}:`, (err as Error).message);
    } finally {
      s.polling = false;
    }
  }
}

/** Start the connector polling scheduler. */
export function startWorkflowListeners(): void {
  if (timer) return;
  stopped = false;
  timer = setInterval(() => { void tickListeners(); }, TICK_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  void tickListeners();
}

/** Stop the connector polling scheduler. */
export function stopWorkflowListeners(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Reset internal state for tests; does not start the scheduler. */
export function resetWorkflowListeners(): void {
  stopped = false;
  state.clear();
}


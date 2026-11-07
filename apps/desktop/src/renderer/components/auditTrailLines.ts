import type { AuditBy, AuditEvent } from '@nekko-agent/shared';

/** How a row of the audit trail reads: what happened, and a tone for its mark. */
export interface AuditLine {
  text: string;
  /** What it touched or who answered, shown quieter. */
  detail?: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
}

/** A turn and the events it wrote, oldest first. */
export interface AuditTurn {
  turnId: string;
  start?: Extract<AuditEvent, { type: 'turn' }>;
  events: AuditEvent[];
}

/** Group a trail by turn, keeping the order it was written in. */
export function groupByTurn(trail: AuditEvent[]): AuditTurn[] {
  const turns: AuditTurn[] = [];
  for (const e of trail) {
    const id = e.turnId ?? '';
    let turn = turns.at(-1);
    if (!turn || turn.turnId !== id || e.type === 'turn') {
      turn = { turnId: id, events: [] };
      turns.push(turn);
    }
    if (e.type === 'turn') turn.start = e;
    else turn.events.push(e);
  }
  return turns;
}

/** Who answered, in words. */
export function describeBy(by: AuditBy | null | undefined): string {
  if (!by) return 'nobody answered';
  // By its current name; a device no longer paired keeps its id.
  const on = (kind: string) => {
    const name = by.deviceName?.trim();
    if (name) return `on ${name} (${kind})`;
    return by.device ? `on a ${kind} (${by.device})` : `on a ${kind}`;
  };
  switch (by.via) {
    case 'this computer': return 'on this computer';
    case 'phone': return on('phone');
    case 'paired computer': return on('paired computer');
    case 'telegram': return 'in Telegram';
    case 'yolo': return 'by YOLO, without asking';
    case 'workflow policy': return "by the workflow's policy";
    case 'mode': return "by the chat's mode";
    case 'rule': return 'by a guardrail rule';
    default: return `via ${by.via}`;
  }
}

/** What a tool call touched, from its value-free detail. */
function touched(detail: Record<string, unknown> | undefined): string | undefined {
  if (!detail) return undefined;
  const parts: string[] = [];
  if (typeof detail.host === 'string') parts.push(detail.host);
  if (typeof detail.path === 'string') parts.push(detail.path);
  if (typeof detail.program === 'string') parts.push(detail.program);
  if (typeof detail.action === 'string') parts.push(detail.action);
  if (typeof detail.server === 'string') parts.push(`server ${detail.server}`);
  if (typeof detail.recipients === 'number' && detail.recipients > 0) {
    parts.push(detail.recipients === 1 ? '1 recipient' : `${detail.recipients} recipients`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}

/** One event as a row. */
export function describeEvent(e: AuditEvent): AuditLine {
  switch (e.type) {
    case 'turn':
      return { text: `Turn started in ${e.mode ?? 'guardrails'}`, detail: [e.claudeCode ? 'Claude Code' : undefined, e.model ?? undefined].filter(Boolean).join(' · ') || undefined, tone: 'neutral' };
    case 'tool': {
      const time = typeof e.ms === 'number' ? `${e.ms} ms` : undefined;
      return {
        text: e.isError ? `${e.tool} failed` : `Ran ${e.tool}`,
        detail: [touched(e.detail), time].filter(Boolean).join(' · ') || undefined,
        tone: e.isError ? 'warn' : 'neutral',
      };
    }
    case 'approval': {
      const asked = `Asked before ${e.tool ?? 'a tool'}${e.severity ? ` (${e.severity})` : ''}`;
      if (e.answer === 'approved') return { text: `${asked}: approved`, detail: describeBy(e.by), tone: e.by?.via === 'yolo' ? 'warn' : 'good' };
      if (e.answer === 'denied') return { text: `${asked}: denied`, detail: describeBy(e.by), tone: 'bad' };
      return { text: `${asked}: no answer`, detail: 'stopped before anyone answered', tone: 'neutral' };
    }
    case 'permission':
      return {
        text: `Claude Code asked to use ${e.tool}: ${e.decision}`,
        detail: [touched(e.detail), describeBy(e.by)].filter(Boolean).join(' · '),
        tone: e.decision === 'denied' ? 'bad' : e.decision === 'approved' ? 'good' : 'neutral',
      };
    case 'taint':
      return { text: 'Read content from outside this computer', detail: `via ${e.by}; sending data out now asks first`, tone: 'warn' };
    case 'redactions': {
      const parts = Object.entries(e.counts).map(([kind, n]) => `${n} ${kind.toLowerCase().replace(/_/g, ' ')}`);
      return { text: 'Privacy Shield hid values before they left', detail: parts.join(', '), tone: 'good' };
    }
  }
}

/** Only the decisions: approvals and Claude Code permissions. */
export function isDecision(e: AuditEvent): boolean {
  return e.type === 'approval' || e.type === 'permission';
}

import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@nekko-agent/shared';
import { describeBy, describeEvent, groupByTurn, isDecision } from './auditTrailLines.js';

const trail: AuditEvent[] = [
  { at: 1, turnId: 't1', type: 'turn', mode: 'guardrails', model: 'qwen3-8b' },
  { at: 2, turnId: 't1', type: 'tool', tool: 'read_file', ms: 3, outputChars: 40, detail: { path: 'app.ts' } },
  { at: 3, turnId: 't1', type: 'approval', tool: 'mcp__srv__post_message', severity: 'medium', answer: 'approved', by: { via: 'phone', device: 'd1' } },
  { at: 4, turnId: 't1', type: 'tool', tool: 'mcp__srv__post_message', ms: 9, detail: { server: 'srv', recipients: 1 } },
  { at: 5, turnId: 't1', type: 'taint', by: 'mcp__srv__post_message' },
  { at: 6, turnId: 't2', type: 'turn', mode: 'yolo' },
  { at: 7, turnId: 't2', type: 'approval', tool: 'fetch_url', severity: 'high', answer: 'approved', by: { via: 'yolo' } },
  { at: 8, turnId: 't2', type: 'redactions', counts: { PII_EMAIL: 2 } },
];

describe('audit trail', () => {
  it('groups events by turn in the order they were written', () => {
    const turns = groupByTurn(trail);
    expect(turns.map((t) => t.turnId)).toEqual(['t1', 't2']);
    expect(turns[0].start?.mode).toBe('guardrails');
    expect(turns[0].events.map((e) => e.type)).toEqual(['tool', 'approval', 'tool', 'taint']);
  });

  it('says what a tool touched and who answered', () => {
    expect(describeEvent(trail[1])).toEqual({ text: 'Ran read_file', detail: 'app.ts · 3 ms', tone: 'neutral' });
    expect(describeEvent(trail[3]).detail).toBe('server srv · 1 recipient · 9 ms');
    expect(describeEvent(trail[2])).toEqual({ text: 'Asked before mcp__srv__post_message (medium): approved', detail: 'on a phone (d1)', tone: 'good' });
    expect(describeEvent(trail[6]).tone).toBe('warn');
    expect(describeEvent(trail[6]).detail).toBe('by YOLO, without asking');
    expect(describeEvent(trail[7]).detail).toBe('2 pii email');
  });

  it('names every way an answer can come', () => {
    expect(describeBy({ via: 'this computer' })).toBe('on this computer');
    expect(describeBy({ via: 'telegram' })).toBe('in Telegram');
    expect(describeBy({ via: 'workflow policy' })).toBe("by the workflow's policy");
    expect(describeBy(null)).toBe('nobody answered');
  });

  it('names the device by its current name, and by id once it is no longer paired', () => {
    expect(describeBy({ via: 'phone', device: 'd1', deviceName: "Davide's Pixel" })).toBe("on Davide's Pixel (phone)");
    expect(describeBy({ via: 'paired computer', device: 'd2', deviceName: 'Studio Mac' })).toBe('on Studio Mac (paired computer)');
    expect(describeBy({ via: 'paired computer', device: 'gone', deviceName: ' ' })).toBe('on a paired computer (gone)');
    expect(describeBy({ via: 'phone' })).toBe('on a phone');
  });

  it('keeps only approvals and permissions in the decisions view', () => {
    expect(trail.filter(isDecision).map((e) => e.at)).toEqual([3, 7]);
  });
});

import React from 'react';
import { create } from 'zustand';
import type { PrivacyKind, PrivacyPreview } from '@nekko-agent/shared';

/**
 * Privacy Shield in the composer: the values in the draft the shield will
 * replace, each with the placeholder the model reads instead. The engine's
 * preview (`privacy:preview`) decides what is private; this only finds those
 * exact values in the draft so the editor can mark them where they are.
 */
export interface PrivacyMark {
  value: string;
  token: string;
  kind: PrivacyKind;
}

/** Where one mark sits in the draft, in UTF-16 offsets (the editor's own). */
export interface PrivacyMarkRange extends PrivacyMark {
  start: number;
  end: number;
}

/** The latest engine preview per chat, shared by the Shield menu and the composer. */
export const usePrivacyPreviews = create<{
  bySession: Record<string, PrivacyPreview | undefined>;
  publish: (sessionId: string, preview: PrivacyPreview | null) => void;
}>((set) => ({
  bySession: {},
  publish: (sessionId, preview) => set((s) => (
    s.bySession[sessionId] === (preview ?? undefined) ? s : { bySession: { ...s.bySession, [sessionId]: preview ?? undefined } }
  )),
}));

const NONE: PrivacyMark[] = [];

/** The draft's marks, when the shield is on and the chat's model is in the cloud. */
export function draftPrivacyMarks(preview: PrivacyPreview | null | undefined, on: boolean): PrivacyMark[] {
  if (!on || !preview || !preview.enabled || preview.reach !== 'cloud') return NONE;
  const marks = preview.findings
    .filter((f) => f.inDraft && f.value)
    .map((f) => ({ value: f.value, token: f.token, kind: f.kind }));
  return marks.length ? marks : NONE;
}

/**
 * Every place a mark's value appears in `text`, without overlaps: a longer
 * value wins over one inside it (an email over the username in it), then the
 * earlier one.
 */
export function privacyMarkRanges(text: string, marks: readonly PrivacyMark[]): PrivacyMarkRange[] {
  if (!text || !marks.length) return [];
  const found: PrivacyMarkRange[] = [];
  for (const m of marks) {
    for (let at = text.indexOf(m.value); at >= 0; at = text.indexOf(m.value, at + m.value.length)) {
      found.push({ ...m, start: at, end: at + m.value.length });
    }
  }
  found.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept: PrivacyMarkRange[] = [];
  for (const r of found) {
    if (!kept.some((k) => r.start < k.end && k.start < r.end)) kept.push(r);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * The editor's styled nodes with each private value wrapped in a mark. Text
 * is walked in document order, so offsets match the editor's `textContent`.
 * A value split across styled spans gets one mark per piece: the first opens
 * the bracket, the last closes it and carries the placeholder, both drawn by
 * CSS so they never become part of the draft's text.
 */
export function markPrivacyNodes(nodes: React.ReactNode[], text: string, marks: readonly PrivacyMark[]): React.ReactNode[] {
  const ranges = privacyMarkRanges(text, marks);
  if (!ranges.length) return nodes;
  let pos = 0;
  let key = 0;
  const walk = (node: React.ReactNode): React.ReactNode => {
    if (typeof node === 'string') {
      const from = pos;
      const to = pos + node.length;
      pos = to;
      const hits = ranges.filter((r) => r.start < to && from < r.end);
      if (!hits.length) return node;
      const out: React.ReactNode[] = [];
      let cursor = 0;
      for (const r of hits) {
        const a = Math.max(r.start, from) - from;
        const b = Math.min(r.end, to) - from;
        if (a > cursor) out.push(node.slice(cursor, a));
        out.push(React.createElement('mark', {
          key: `pm${key++}`,
          className: 'composer-privacy-mark',
          'data-privacy-kind': r.kind,
          'data-privacy-open': r.start >= from ? '' : undefined,
          'data-privacy-token': r.end <= to ? r.token : undefined,
        }, node.slice(a, b)));
        cursor = b;
      }
      if (cursor < node.length) out.push(node.slice(cursor));
      return React.createElement(React.Fragment, { key: `pf${key++}` }, ...out);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (React.isValidElement<{ children?: React.ReactNode }>(node) && node.props.children !== undefined) {
      const children = node.props.children;
      return React.cloneElement(node, undefined, ...(Array.isArray(children) ? children.map(walk) : [walk(children)]));
    }
    return node;
  };
  return nodes.map(walk);
}
